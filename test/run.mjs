#!/usr/bin/env node
/**
 * Regression tests over the fixtures.
 *
 * These pin the behaviours that are easy to break while tuning rules: the
 * locatorSafe exemption, blocker classification, hierarchy unification, and the
 * fact that Java produces no async work at all.
 */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildLedger } from "../packages/core/ledger.mjs";
import { analyse } from "../packages/csharp-async/closure.mjs";
import { loadLocalRules, applyRules } from "../packages/core/local-rules.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;

function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}

function load(dir, ext) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(full) === ext) out.push({ path: full, src: readFileSync(full, "utf8") });
    }
  })(join(root, dir));
  return out;
}

console.log("\nselenium-shift tests\n");

// ---- C# ledger ---------------------------------------------------------
const cs = load("fixtures/csharp", ".cs");
const csLedger = buildLedger(cs, "csharp");

check("C# ledger finds call sites", csLedger.summary.callSites > 15, `got ${csLedger.summary.callSites}`);
check("C# ledger leaves nothing unmapped", csLedger.summary.unmapped === 0, `${csLedger.summary.unmapped} unmapped`);

const fps = csLedger.clusters.map((c) => c.fingerprint);
check(
  "variable arguments collapse with each other",
  fps.includes("$R.SendKeys($ARG)") && !fps.includes("$R.SendKeys(user)"),
);
check(
  "string concatenation is not mistaken for a literal",
  fps.some((f) => f.includes("By.XPath($EXPR)")),
);
check(
  "waits are marked for deletion, never translation",
  csLedger.clusters.filter((c) => c.confidence === "delete").length >= 4,
);

// ---- C# async closure --------------------------------------------------
const plan = analyse(cs);
const byName = (n) => plan.members.find((m) => m.name === n);

check("closure propagates to test methods", !!byName("UserCanCheckOut"), "test method not reached");
check(
  "interface and implementer unify",
  (byName("Login")?.hierarchy?.types || []).length > 1,
);
check(
  "interface declarations get Task without async",
  plan.members.some(
    (m) => m.file.includes("IAuthenticatable") && m.proposedSignature?.startsWith("Task") &&
      !m.proposedSignature.includes("async")
  ),
);
check(
  "test methods are not renamed with an Async suffix",
  byName("UserCanCheckOut")?.proposedSignature?.includes("UserCanCheckOut()"),
  byName("UserCanCheckOut")?.proposedSignature,
);
check(
  "void becomes Task, typed returns become Task<T>",
  byName("Checkout")?.proposedSignature?.includes("Task CheckoutAsync") &&
    byName("Total")?.proposedSignature?.includes("Task<string> TotalAsync"),
);

// The locatorSafe exemption is the load-bearing rule of the whole design.
for (const prop of ["UsernameField", "PasswordField", "SubmitButton", "CheckoutButton"]) {
  check(`locator property "${prop}" stays synchronous`, !byName(prop));
}

const blockerKinds = new Set(plan.members.flatMap((m) => m.blockers.map((b) => b.kind)));
for (const kind of ["property", "iterator", "linq-predicate"]) {
  check(`detects ${kind} blocker`, blockerKinds.has(kind));
}
check(
  "a property performing a real action IS blocked",
  byName("ErrorMessage")?.blockers.some((b) => b.kind === "property"),
);

// ---- Java --------------------------------------------------------------
const java = load("fixtures/java", ".java");
const javaLedger = buildLedger(java, "java");
check("Java ledger leaves nothing unmapped", javaLedger.summary.unmapped === 0);
check(
  "no Java rule is marked async — the Java binding is synchronous",
  javaLedger.clusters.every((c) => !c.async),
);

// ---- Project-local rule overlay ----------------------------------------
// The overlay exists so a codebase's own idioms are decided once and replayed,
// instead of being rediscovered by a human (or a model) on every run.
const mktemp = () => {
  const dir = join(tmpdir(), `selenium-shift-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const emptyOverlay = loadLocalRules(mktemp());
check(
  "a suite with no overlay file loads an empty overlay, not an error",
  emptyOverlay.tier1.length === 0 && emptyOverlay.source === null,
);

const overlayDir = mktemp();
mkdirSync(join(overlayDir, ".selenium-shift"), { recursive: true });
writeFileSync(
  join(overlayDir, ".selenium-shift", "rules.local.json"),
  JSON.stringify({
    tier1: [{ id: "unwrap-find", find: "\\bDriver\\.FindElement\\((\\w+)\\)", replace: "$1", regex: true }],
    memberBody: [{ id: "helper", find: "Helper.Type(", replace: "await Helper.TypeAsync(" }],
  }),
);
const overlay = loadLocalRules(overlayDir);
check("overlay loads tier1 and memberBody rules", overlay.tier1.length === 1 && overlay.memberBody.length === 1);
check(
  "a tier1 rule rewrites the source",
  applyRules("Driver.FindElement(locator).Click();", overlay.tier1).result === "locator.Click();",
);
check(
  "memberBody rules may introduce await",
  applyRules("Helper.Type(x);", overlay.memberBody).result === "await Helper.TypeAsync(x);",
);

// Tier 1 runs file-wide and cannot tell a sync property from an async method,
// so a rule that injects `await` there would produce uncompilable code. The
// loader has to reject it rather than let it through.
let rejected = false;
try {
  const bad = mktemp();
  mkdirSync(join(bad, ".selenium-shift"), { recursive: true });
  writeFileSync(
    join(bad, ".selenium-shift", "rules.local.json"),
    JSON.stringify({ tier1: [{ id: "bad", find: "x.Click()", replace: "await x.ClickAsync()" }] }),
  );
  loadLocalRules(bad);
} catch (err) {
  rejected = /may not introduce "await"/.test(err.message);
}
check("a tier1 rule injecting await is rejected at load time", rejected);

// asyncSeeds is the escape hatch for helpers defined outside the scanned tree,
// which the closure pass cannot otherwise discover.
const seededPlan = analyse(
  [{ path: "Ext.cs", src: "class P { public void Go() { ExternalHelper.Navigate(\"/x\"); } }" }],
  { asyncSeeds: [/ExternalHelper\.Navigate/] },
);
check(
  "asyncSeeds forces a member async with no Selenium call in it",
  seededPlan.members.some((m) => m.name === "Go"),
);
check(
  "without asyncSeeds the same member stays synchronous",
  !analyse([{ path: "Ext.cs", src: "class P { public void Go() { ExternalHelper.Navigate(\"/x\"); } }" }])
    .members.some((m) => m.name === "Go"),
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
