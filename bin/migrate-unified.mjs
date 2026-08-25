#!/usr/bin/env node
/**
 * selenium-shift migrate-unified
 *
 * Unified migration: Tier 1 (imports/locators) + Tier 3 (async signatures and
 * member-body interaction rewrites) in one pass. Framework-agnostic. No
 * assumptions about code structure.
 *
 * Output is deliberately budgeted. Everything this prints becomes input
 * tokens for whatever reads it next, on every subsequent turn — so the
 * default run reports grouped counts only. Per-site detail goes to --report,
 * which can be grepped on demand instead of being carried in context.
 *
 * Usage:
 *   node migrate-unified.mjs <dir> [--dry-run] [--verbose]
 *                                  [--rules <path>] [--report <path>]
 */

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { analyse } from "../packages/csharp-async/closure.mjs";
import { loadLocalRules, applyRules, LOCAL_RULES_PATH } from "../packages/core/local-rules.mjs";

const SKIP = new Set(["node_modules", "bin", "obj", "target", ".git", "build", "out"]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (extname(full) === ".cs") acc.push({ path: full, content: readFileSync(full, "utf8") });
  }
  return acc;
}

// Delete whole lines containing dead wait/lifecycle machinery. Line-based
// (rather than a `[^)]*` regex) because these statements routinely nest
// parens — `new WebDriverWait(driver, TimeSpan.FromSeconds(10))` — and a
// naive non-nesting regex truncates mid-statement, leaving stray fragments
// like `Wait = );` behind.
const DEAD_LINE_MARKERS = [
  "new WebDriverWait(",
  "Wait.Until(",
  ".ImplicitWait =",
  "WebDriverWait Wait",
  "Thread.Sleep(",
];

function stripDeadLines(src) {
  const before = src;
  const result = src
    .split("\n")
    .filter((line) => !DEAD_LINE_MARKERS.some((marker) => line.includes(marker)))
    .join("\n");
  return { result, changed: result !== before };
}

// Generic Tier 1 transformations (safe, universal, file-wide — no awareness
// of which member they land in, so nothing here may introduce `await`).
function applyTier1(src, localRules) {
  let result = src;
  let changeCount = 0;
  const localApplied = [];

  // Remove Selenium imports
  const importBefore = result;
  result = result
    .replace(/using OpenQA\.Selenium\.Support[^;]*;?\n?/g, "")
    .replace(/using OpenQA\.Selenium[^;]*;?\n?/g, "");
  if (result !== importBefore) changeCount++;

  // Delete dead wait/lifecycle statements before anything else touches them.
  const dead = stripDeadLines(result);
  if (dead.changed) changeCount++;
  result = dead.result;

  // Replace FindElement(By.*) with <receiver>.Locator(). Keeping the
  // original receiver ($1) rather than hardcoding "Page" is what keeps this
  // safe regardless of whether the field is named Driver, _driver or Page.
  const findElementPatterns = [
    [/\b(\w+)\.FindElement\(By\.Id\("([^"]+)"\)\)/g, '$1.Locator("#$2")'],
    [/\b(\w+)\.FindElement\(By\.ClassName\("([^"]+)"\)\)/g, '$1.Locator(".$2")'],
    [/\b(\w+)\.FindElement\(By\.CssSelector\("([^"]+)"\)\)/g, '$1.Locator("$2")'],
    [/\b(\w+)\.FindElement\(By\.XPath\("([^"]+)"\)\)/g, '$1.Locator("$2")'],
  ];

  for (const [pattern, replacement] of findElementPatterns) {
    if (pattern.test(result)) {
      result = result.replace(pattern, replacement);
      changeCount++;
    }
  }

  // Convert IWebDriver -> IPage (parameter/field/local declarations)
  const driverBefore = result;
  result = result.replace(/\bIWebDriver\b/g, "IPage");
  if (result !== driverBefore) changeCount++;

  // Convert IWebElement -> ILocator. Selenium's element handle has no
  // Playwright equivalent; ILocator is the type every FindElement rewrite
  // above now returns, so every declared IWebElement site must follow.
  const elementBefore = result;
  result = result.replace(/\bIWebElement\b/g, "ILocator");
  if (result !== elementBefore) changeCount++;

  // `By locator` as a parameter/local type -> `ILocator locator`. Restricted
  // to the "By <name>" shape immediately before `,` or `)` so a call like
  // `By.Id(...)` is never touched.
  const byParamBefore = result;
  result = result.replace(/\bBy(\s+\w+)(?=[,)])/g, "ILocator$1");
  if (result !== byParamBefore) changeCount++;

  // Project-local rules last, so they see the built-in output and can correct
  // it. These are the decisions a human made once about this codebase's own
  // idioms; the loader has already rejected any that would inject `await`.
  if (localRules.tier1.length) {
    const local = applyRules(result, localRules.tier1);
    if (local.applied.length) {
      result = local.result;
      changeCount += local.applied.length;
      localApplied.push(...local.applied);
    }
  }

  return { result, changeCount, localApplied };
}

// Decide the Playwright/Task usings a file needs by scanning its FINAL
// content — must run after Phase 3, not during Tier 1, because interface
// files like IAuthenticatable only gain `Task`-returning signatures in
// Phase 3 and have no IPage/ILocator reference to trigger an earlier check.
function ensureImports(content) {
  let result = content;
  const needsPlaywright = /\bIPage\b|\bILocator\b/.test(result) && !result.includes("using Microsoft.Playwright");
  const needsTasks = /\bTask\b/.test(result) && !result.includes("using System.Threading.Tasks");
  if (!needsPlaywright && !needsTasks) return { result, changed: false };

  const firstLine = result.match(/^(using |namespace )/m);
  if (!firstLine) return { result, changed: false };

  const pos = result.indexOf(firstLine[0]);
  let imports = "";
  if (needsPlaywright) imports += "using Microsoft.Playwright;\n";
  if (needsTasks) imports += "using System.Threading.Tasks;\n";
  result = result.slice(0, pos) + imports + result.slice(pos);
  return { result, changed: true };
}

// Tier 3 member-body rewrites: the common Selenium interaction idioms,
// translated to their Playwright async equivalents. Scoped to a single
// member's body text (never the whole file) so `await` is only ever
// introduced inside a body already proven safe to make async — never inside
// a synchronous property getter.
function rewriteMemberBody(body, localRules) {
  let result = body
    // Clear() immediately followed by SendKeys(x) on the same locator
    // collapses to a single FillAsync(x), matching Playwright's model.
    .replace(/(\w+)\.Clear\(\);\s*\n\s*\1\.SendKeys\(([^)]*)\);/g, "await $1.FillAsync($2);")
    .replace(/(\w+)\.SendKeys\(([^)]*)\);/g, "await $1.FillAsync($2);")
    .replace(/(\w+)\.Clear\(\);/g, "await $1.ClearAsync();")
    .replace(/(\w+)\.Click\(\);/g, "await $1.ClickAsync();")
    .replace(/(\w+)\.Navigate\(\)\.GoToUrl\(([^)]*)\);/g, "await $1.GotoAsync($2);")
    .replace(/return\s+([^;]+?)\.Text;/g, "return await $1.TextContentAsync();")
    .replace(/return\s+([^;]+?)\.Displayed;/g, "return await $1.IsVisibleAsync();");

  if (localRules.memberBody.length) {
    result = applyRules(result, localRules.memberBody).result;
  }
  return result;
}

// Markers that mean "Selenium residue survived the rewrite" — either the
// pattern was never recognized (e.g. FindElement(locator) where locator is a
// variable, not a By.* literal) or it sits in a member Phase 3 deliberately
// left alone (a blocker). Either way the file will not compile, so surface
// it instead of letting it pass silently.
const RESIDUE_MARKERS = [
  ["FindElement(", "still calls Selenium's FindElement — Tier 1 only rewrites By.Id/ClassName/CssSelector/XPath with a literal argument"],
  ["FindElements(", "still calls Selenium's FindElements — no automatic rewrite; see the loc.find-elements guidance (AllAsync/CountAsync)"],
  ["Thread.Sleep(", "hard sleep survived — should have been deleted"],
  ["WebDriverWait", "explicit-wait type survived — should have been deleted"],
  ["IWebDriver", "Selenium driver type survived the IPage conversion"],
  ["IWebElement", "Selenium element type survived the ILocator conversion"],
  [".ImplicitWait", "implicit wait survived — should have been deleted"],
];

function findResidue(content, relPath, residueIgnore) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (residueIgnore.some((ignore) => lines[i].includes(ignore))) continue;
    for (const [marker, note] of RESIDUE_MARKERS) {
      if (lines[i].includes(marker)) hits.push({ file: relPath, line: i + 1, marker, note });
    }
  }
  return hits;
}

function groupBy(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

// Full per-site detail, written to a file rather than printed. A reader that
// needs one blocker can grep for it; a reader that does not pays nothing.
function renderReport({ files, tier1Results, asyncMembers, blockedMembers, residue, localRules }) {
  const lines = [
    "# selenium-shift migration report",
    "",
    `Generated ${new Date().toISOString()}`,
    "",
    `- Files scanned: ${files.length}`,
    `- Files changed: ${tier1Results.length}`,
    `- Async conversions: ${asyncMembers.length}`,
    `- Blockers: ${blockedMembers.length}`,
    `- Residue: ${residue.length}`,
    `- Local rules: ${localRules.source || "none"}`,
    "",
  ];

  if (blockedMembers.length) {
    lines.push("## Blockers", "");
    for (const [kind, items] of groupBy(blockedMembers, (b) => b.blockers[0].kind)) {
      lines.push(`### ${kind} (${items.length})`, "");
      for (const item of items) {
        lines.push(`- \`${item.file}:${item.line}\` — \`${item.type}.${item.name}\``);
        lines.push(`  - ${item.blockers[0].fix}`);
      }
      lines.push("");
    }
  }

  if (residue.length) {
    lines.push("## Residue", "");
    for (const [marker, items] of groupBy(residue, (r) => r.marker)) {
      lines.push(`### \`${marker}\` (${items.length})`, "", items[0].note, "");
      for (const item of items) lines.push(`- \`${item.file}:${item.line}\``);
      lines.push("");
    }
  }

  if (asyncMembers.length) {
    lines.push("## Async conversions", "");
    for (const m of asyncMembers) {
      lines.push(`- \`${m.file}:${m.line}\``);
      lines.push(`  - \`${m.currentSignature}\``);
      lines.push(`  - \`${m.proposedSignature}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const root = process.argv[2];
  if (!root || root.startsWith("--")) {
    console.error("usage: migrate-unified.mjs <dir> [--dry-run] [--verbose] [--rules <path>] [--report <path>]");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");
  const reportPath = arg("--report");

  let localRules;
  try {
    localRules = loadLocalRules(root, arg("--rules"));
  } catch (err) {
    console.error(`rules: ${err.message}`);
    process.exit(1);
  }

  const files = walk(root);
  if (!files.length) {
    console.error(`no .cs files found under ${root}`);
    process.exit(1);
  }

  // === Phase 1: Tier 1 transformations ===
  const tier1Results = [];
  const localRuleHits = new Set();
  let totalTier1Changes = 0;

  for (const file of files) {
    const { result, changeCount, localApplied } = applyTier1(file.content, localRules);
    if (changeCount > 0) {
      tier1Results.push({ path: file.path, content: result, changeCount, edits: [] });
      totalTier1Changes += changeCount;
      for (const id of localApplied) localRuleHits.add(id);
    }
  }

  if (!tier1Results.length) {
    console.log(`no Selenium patterns matched in ${files.length} file(s) — nothing to migrate`);
    return;
  }

  // === Phase 2: Async analysis (Tier 3 planning) ===
  const filesToAnalyze = tier1Results.map((r) => ({
    path: relative(process.cwd(), r.path),
    src: r.content,
  }));

  const analysis = analyse(filesToAnalyze, { asyncSeeds: localRules.asyncSeeds });
  const { members } = analysis;

  // `members` already contains only members that become async in some sense
  // (closure.mjs seeds/propagates isAsync before returning them) — includes
  // interface/abstract declarations, which get a Task-returning signature
  // without the `async` keyword. Unblocked ones are safe to auto-apply.
  const asyncMembers = members.filter((m) => !m.blockers.length);
  const blockedMembers = members.filter((m) => m.blockers.length);

  // === Phase 3: apply the safe async signature + body rewrites ===
  const byRelPath = new Map(tier1Results.map((r) => [relative(process.cwd(), r.path), r]));

  for (const m of asyncMembers) {
    const entry = byRelPath.get(m.file);
    if (!entry || m.headerStart == null || m.headerEnd == null) continue;

    // headerStart sits right after the previous member (or the type's
    // opening brace), so it includes the blank line/indentation before the
    // declaration. Preserve that leading whitespace instead of swallowing
    // it, or consecutive members get mashed onto one line.
    const rawHeader = entry.content.slice(m.headerStart, m.headerEnd);
    const leadingWs = /^\s*/.exec(rawHeader)[0];
    const trailingWs = /\s*$/.exec(rawHeader)[0];
    entry.edits.push({ start: m.headerStart, end: m.headerEnd, text: leadingWs + m.proposedSignature + trailingWs });

    if (m.bodyStart != null && m.bodyEnd != null && m.kind === "method") {
      const bodyText = entry.content.slice(m.bodyStart, m.bodyEnd);
      const newBody = rewriteMemberBody(bodyText, localRules);
      if (newBody !== bodyText) {
        entry.edits.push({ start: m.bodyStart, end: m.bodyEnd, text: newBody });
      }
    }
  }

  let filesWithAsyncEdits = 0;
  for (const entry of tier1Results) {
    if (!entry.edits.length) continue;
    filesWithAsyncEdits++;
    // Apply bottom-up so earlier offsets in the same file stay valid.
    entry.edits.sort((a, b) => b.start - a.start);
    let content = entry.content;
    for (const e of entry.edits) {
      content = content.slice(0, e.start) + e.text + content.slice(e.end);
    }
    entry.content = content;
  }

  for (const entry of tier1Results) {
    const { result, changed } = ensureImports(entry.content);
    if (changed) {
      entry.content = result;
      entry.changeCount++;
      totalTier1Changes++;
    }
  }

  // === Verify: flag Selenium residue that survived the rewrite ===
  const residue = tier1Results.flatMap((entry) =>
    findResidue(entry.content, relative(process.cwd(), entry.path), localRules.residueIgnore)
  );

  // === Apply ===
  if (!dryRun) {
    for (const result of tier1Results) {
      writeFileSync(result.path, result.content, "utf8");
    }
  }

  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      renderReport({ files, tier1Results, asyncMembers, blockedMembers, residue, localRules }),
      "utf8"
    );
  }

  // === Summary — grouped counts only, no per-site enumeration ===
  console.log(`${dryRun ? "dry run" : "applied"}: ${tier1Results.length}/${files.length} files changed`);
  console.log(`  tier1 rewrites   ${totalTier1Changes}`);
  console.log(`  async converted  ${asyncMembers.length} across ${filesWithAsyncEdits} file(s)`);
  console.log(`  blockers         ${blockedMembers.length}`);
  console.log(`  residue          ${residue.length}`);
  if (localRules.source) {
    console.log(`  local rules      ${localRuleHits.size}/${localRules.tier1.length + localRules.memberBody.length} matched`);
  }

  if (blockedMembers.length) {
    console.log("\nblockers by kind (each needs a human decision):");
    for (const [kind, items] of groupBy(blockedMembers, (b) => b.blockers[0].kind)) {
      console.log(`  ${String(items.length).padStart(4)}  ${kind} — ${items[0].blockers[0].fix}`);
    }
  }

  if (residue.length) {
    console.log("\nresidue by marker (will not compile):");
    for (const [marker, items] of groupBy(residue, (r) => r.marker)) {
      console.log(`  ${String(items.length).padStart(4)}  ${marker}`);
    }
    if (!localRules.source) {
      console.log(`\n  Residue usually means a project-specific idiom the built-in rules do not know.`);
      console.log(`  Decide it once in ${LOCAL_RULES_PATH} and re-run; the decision then replays for free.`);
    }
  }

  if (reportPath) console.log(`\nper-site detail -> ${reportPath}`);

  if (verbose) {
    console.log("\nasync conversions:");
    for (const m of asyncMembers) {
      console.log(`  ${m.file}:${m.line}  ${m.currentSignature}  ->  ${m.proposedSignature}`);
    }
    console.log("\nresidue sites:");
    for (const r of residue) console.log(`  ${r.file}:${r.line}  ${r.marker}`);
  }

  if (!dryRun && (blockedMembers.length || asyncMembers.length)) {
    console.log(
      "\nNot done by this pass (Tier 2, by hand): call sites in other members that invoke a\n" +
      "now-renamed async method still need `await`, and the [SetUp]/[TearDown] driver\n" +
      "lifecycle still needs migrating to PageTest."
    );
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
