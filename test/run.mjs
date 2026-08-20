#!/usr/bin/env node
/**
 * Regression tests over the fixtures.
 *
 * These pin the behaviours that are easy to break while tuning rules: the
 * locatorSafe exemption, blocker classification, hierarchy unification, and the
 * fact that Java produces no async work at all.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildLedger } from "../packages/core/ledger.mjs";
import { analyse } from "../packages/csharp-async/closure.mjs";

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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
