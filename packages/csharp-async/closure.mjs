/**
 * Async closure for C#.
 *
 * Selenium's C# binding is synchronous. Playwright's is async-only — there is
 * an open request for a sync API (microsoft/playwright-dotnet#2715) that has
 * sat at P3 since 2023, so this is not going to change. `async` in C# is viral:
 * once a page-object method awaits something, every caller must await it too,
 * all the way up to the [Test] method.
 *
 * That makes this a whole-program problem, not a file-by-file one. A method
 * declared on an interface and implemented in six classes has to change in all
 * seven places or nothing compiles. So: build the call graph, seed it from the
 * calls that become async, and propagate to a fixpoint.
 *
 * The single most important rule here is `locatorSafe`. In Playwright .NET,
 * creating a locator is synchronous — only *acting* on one is async. So
 *
 *     public ILocator SubmitButton => Page.GetByTestId("submit");
 *
 * stays an ordinary synchronous property. Page objects are usually
 * property-heavy, so honouring this stops async from reaching a large share of
 * the members a naive tool would rewrite.
 */

import { scanFile } from "../core/scanner.mjs";
import { extractChains, fingerprint, touchesSelenium } from "../core/chains.mjs";
import { loadRules } from "../core/ledger.mjs";

const LINQ_METHODS = [
  "Where", "Select", "SelectMany", "Any", "All", "First", "FirstOrDefault",
  "Single", "SingleOrDefault", "Count", "OrderBy", "OrderByDescending",
  "TakeWhile", "SkipWhile", "GroupBy", "Sum", "Min", "Max", "Aggregate",
];

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function analyse(files) {
  const rules = loadRules("csharp");
  const asyncRuleIds = new Set(
    rules.rules.filter((r) => r.async && !r.locatorSafe).map((r) => r.match)
  );

  const types = [];
  const members = [];
  const scans = [];

  for (const { path, src } of files) {
    const scanned = scanFile(src, path, "csharp");
    scans.push(scanned);
    for (const t of scanned.types) {
      types.push(t);
      for (const m of t.members) {
        m.typeRef = t;
        m.scan = scanned;
        m.key = `${t.name}.${m.name}/${m.paramCount}`;
        members.push(m);
      }
    }
  }

  const byName = new Map();
  for (const m of members) {
    if (!byName.has(m.name)) byName.set(m.name, []);
    byName.get(m.name).push(m);
  }
  const typeByName = new Map(types.map((t) => [t.name, t]));

  // ---- 1. Seed: members containing a call that becomes async -------------
  const seeded = new Set();
  const seedReasons = new Map();

  for (const m of members) {
    if (m.bodyStart == null) continue;
    const chains = extractChains(m.scan.src, m.scan.masked, m.bodyStart, m.bodyEnd);
    for (const chain of chains) {
      if (!touchesSelenium(chain.text)) continue;
      const { fingerprint: fp } = fingerprint(chain.text);
      const hit = [...asyncRuleIds].find((pat) => fp === pat || fp.includes(pat));
      if (hit) {
        seeded.add(m.key);
        if (!seedReasons.has(m.key)) seedReasons.set(m.key, []);
        const reasons = seedReasons.get(m.key);
        if (reasons.length < 3) reasons.push(chain.text.replace(/\s+/g, " ").slice(0, 90));
      }
    }
  }

  // ---- 2. Hierarchy groups: an override must match its base -------------
  const uf = new UnionFind();
  for (const m of members) uf.find(m.key);

  const ancestorsOf = (typeName, seen = new Set()) => {
    const t = typeByName.get(typeName);
    if (!t) return seen;
    for (const b of t.bases) {
      if (seen.has(b)) continue;
      seen.add(b);
      ancestorsOf(b, seen);
    }
    return seen;
  };

  for (const m of members) {
    if (m.kind === "ctor") continue;
    for (const anc of ancestorsOf(m.type)) {
      const ancType = typeByName.get(anc);
      if (!ancType) continue;
      const match = ancType.members.find(
        (x) => x.name === m.name && x.paramCount === m.paramCount && x.kind === m.kind
      );
      if (match) uf.union(m.key, `${ancType.name}.${match.name}/${match.paramCount}`);
    }
  }

  // ---- 3. Call graph -----------------------------------------------------
  const callers = new Map(); // callee key -> Set(caller keys)
  const addEdge = (calleeKey, callerKey) => {
    if (!callers.has(calleeKey)) callers.set(calleeKey, new Set());
    callers.get(calleeKey).add(callerKey);
  };

  for (const m of members) {
    if (m.bodyStart == null) continue;
    const body = m.scan.masked.slice(m.bodyStart, m.bodyEnd);
    for (const [name, candidates] of byName) {
      if (name === m.name) continue;
      const re = new RegExp(`\\b${name}\\b`, "g");
      if (!re.test(body)) continue;
      for (const c of candidates) {
        if (c.kind === "ctor") continue;
        addEdge(c.key, m.key);
      }
    }
  }

  // ---- 4. Fixpoint ------------------------------------------------------
  const isAsync = new Set();
  const via = new Map();
  const queue = [];

  const mark = (key, reason) => {
    const root = uf.find(key);
    // Marking one member of a hierarchy group marks the whole group.
    for (const m of members) {
      if (uf.find(m.key) !== root || isAsync.has(m.key)) continue;
      isAsync.add(m.key);
      via.set(m.key, reason);
      queue.push(m.key);
    }
  };

  for (const key of seeded) mark(key, { kind: "playwright-call", detail: seedReasons.get(key) });

  while (queue.length) {
    const key = queue.shift();
    for (const caller of callers.get(key) || []) {
      if (isAsync.has(caller)) continue;
      mark(caller, { kind: "calls-async", detail: [key] });
    }
  }

  // ---- 5. Blockers ------------------------------------------------------
  const linqUses = findLinqUses(members, byName);
  const results = [];

  for (const m of members) {
    if (!isAsync.has(m.key)) continue;
    const blockers = [];

    if (m.kind === "ctor") {
      blockers.push({
        kind: "constructor",
        fix: "Constructors cannot be async. Move the work into an async factory method, or into the Playwright fixture that builds the page object.",
      });
    }
    if (m.kind === "property") {
      blockers.push({
        kind: "property",
        fix: "C# properties cannot be async. If it returns an element, change the type to ILocator and keep it synchronous — locator creation does not need await. If it genuinely performs an action, convert it to a method returning Task<T>.",
      });
    }
    if (/\byield\s+(return|break)\b/.test(m.body)) {
      blockers.push({
        kind: "iterator",
        fix: "An iterator cannot also be async in the ordinary way. Return IAsyncEnumerable<T> and mark the method `async`, or materialise the sequence before returning it.",
      });
    }
    if (linqUses.has(m.name)) {
      blockers.push({
        kind: "linq-predicate",
        fix: `Called inside a LINQ lambda (${[...linqUses.get(m.name)].join(", ")}), where you cannot await. Rewrite as an explicit foreach loop, or await the values first and query the materialised results.`,
      });
    }

    const group = members.filter((x) => uf.find(x.key) === uf.find(m.key));
    const spansInterface = group.some((x) => x.typeRef.isInterface);
    const spansTypes = new Set(group.map((x) => x.type));

    results.push({
      key: m.key,
      file: m.file,
      line: m.line,
      type: m.type,
      kind: m.kind,
      name: m.name,
      returnType: m.returnType,
      currentSignature: `${m.mods.join(" ")} ${m.returnType ?? ""} ${m.name}${m.params != null ? `(${m.params})` : ""}`.replace(/\s+/g, " ").trim(),
      proposedSignature: proposeSignature(m),
      reason: via.get(m.key),
      blockers,
      hierarchy: spansTypes.size > 1
        ? { spansInterface, types: [...spansTypes] }
        : null,
    });
  }

  results.sort((a, b) => (b.blockers.length - a.blockers.length) || a.file.localeCompare(b.file) || a.line - b.line);

  const total = members.filter((m) => m.kind !== "ctor").length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      files: files.length,
      types: types.length,
      members: total,
      seeded: seeded.size,
      becomeAsync: results.length,
      asyncShare: total ? +((results.length / total) * 100).toFixed(1) : 0,
      blocked: results.filter((r) => r.blockers.length).length,
      hierarchyGroups: results.filter((r) => r.hierarchy).length,
    },
    members: results,
  };
}

function proposeSignature(m) {
  if (m.kind === "ctor") return null;
  const mods = m.mods.filter((x) => x !== "async");
  const rt = (m.returnType || "").trim();
  const newReturn =
    rt === "void" || rt === "" ? "Task" :
    /^Task(<.*>)?$/.test(rt) ? rt :
    `Task<${rt}>`;

  // `async` is an implementation detail, not part of a declaration. An
  // interface member or abstract method returns Task without being async.
  const declarationOnly = m.typeRef?.isInterface || m.isAbstract;

  // Test methods keep their names — the Async suffix is a .NET convention for
  // library APIs, and renaming a test breaks every filter, report and CI job
  // that refers to it.
  const name =
    m.isTestMethod || m.name.endsWith("Async") ? m.name : `${m.name}Async`;

  const params = m.params != null ? `(${m.params})` : "";
  const parts = declarationOnly ? mods : [...mods, "async"];
  return `${parts.join(" ")} ${newReturn} ${name}${params}`.replace(/\s+/g, " ").trim();
}

/** Map of member name -> LINQ operators it is used inside. */
function findLinqUses(members, byName) {
  const uses = new Map();
  for (const m of members) {
    if (m.bodyStart == null) continue;
    const body = m.body;
    for (const op of LINQ_METHODS) {
      const re = new RegExp(`\\.${op}\\s*\\(([^;]{0,300}?)\\)`, "g");
      let match;
      while ((match = re.exec(body)) !== null) {
        const inner = match[1];
        if (!inner.includes("=>")) continue;
        for (const name of byName.keys()) {
          if (new RegExp(`\\b${name}\\b`).test(inner)) {
            if (!uses.has(name)) uses.set(name, new Set());
            uses.get(name).add(op);
          }
        }
      }
    }
  }
  return uses;
}
