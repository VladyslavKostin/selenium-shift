/**
 * Project-local rule overlay.
 *
 * The built-in rules in packages/rules/ cover the idioms every Selenium suite
 * shares. They cannot cover the ones a specific team invented — a homegrown
 * `ElementHelper.WaitAndClick`, a `BasePage.SafeType`, a custom attribute.
 * Those show up in the inventory ledger as `unmapped`, and each one needs a
 * decision exactly once.
 *
 * This module loads those decisions from a file in the migrated repo, so the
 * decision is made once by a human (or once by a model, reviewed by a human),
 * committed, and replayed for free on every subsequent run.
 *
 * Location: <suite-root>/.selenium-shift/rules.local.json, or --rules <path>.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_RULES_PATH = ".selenium-shift/rules.local.json";

const EMPTY = { tier1: [], memberBody: [], asyncSeeds: [], residueIgnore: [], source: null };

function compileRule(rule, bucket, index) {
  const where = `${bucket}[${index}]${rule.id ? ` (${rule.id})` : ""}`;
  if (typeof rule.find !== "string" || !rule.find) {
    throw new Error(`${where}: "find" must be a non-empty string`);
  }
  if (typeof rule.replace !== "string") {
    throw new Error(`${where}: "replace" must be a string`);
  }
  // Tier 1 runs file-wide, with no knowledge of which member it lands in — it
  // cannot know whether the enclosing member is allowed to be async. A rule
  // that injects `await` there would land inside synchronous property getters
  // and produce code that does not compile. Member-body rules run only inside
  // members the closure pass already proved async, so they may.
  if (bucket === "tier1" && /\bawait\b/.test(rule.replace)) {
    throw new Error(
      `${where}: tier1 replacements may not introduce "await" — Tier 1 is file-wide and ` +
      `cannot tell a sync property from an async method. Move this rule to "memberBody".`
    );
  }
  let re;
  try {
    re = rule.regex
      ? new RegExp(rule.find, rule.flags || "g")
      : new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  } catch (err) {
    throw new Error(`${where}: invalid regex — ${err.message}`);
  }
  return { id: rule.id || `${bucket}-${index}`, re, replace: rule.replace, note: rule.note || null };
}

export function loadLocalRules(suiteRoot, explicitPath = null) {
  const path = explicitPath || join(suiteRoot, LOCAL_RULES_PATH);
  if (!existsSync(path)) return { ...EMPTY };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: not valid JSON — ${err.message}`);
  }

  const tier1 = (raw.tier1 || []).map((r, i) => compileRule(r, "tier1", i));
  const memberBody = (raw.memberBody || []).map((r, i) => compileRule(r, "memberBody", i));

  // Members whose bodies match one of these become async seeds even though
  // they contain no recognisable Selenium call — the escape hatch for helpers
  // that live outside the scanned tree (a shared NuGet package, another
  // project) and so cannot be discovered by the closure pass on their own.
  const asyncSeeds = (raw.asyncSeeds || []).map((s, i) => {
    if (typeof s !== "string" || !s) throw new Error(`asyncSeeds[${i}]: must be a non-empty string`);
    try {
      return new RegExp(s);
    } catch (err) {
      throw new Error(`asyncSeeds[${i}]: invalid regex — ${err.message}`);
    }
  });

  const residueIgnore = (raw.residueIgnore || []).map((s, i) => {
    if (typeof s !== "string" || !s) throw new Error(`residueIgnore[${i}]: must be a non-empty string`);
    return s;
  });

  return { tier1, memberBody, asyncSeeds, residueIgnore, source: path };
}

export function applyRules(src, rules) {
  let result = src;
  const applied = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    const before = result;
    result = result.replace(rule.re, rule.replace);
    if (result !== before) applied.push(rule.id);
  }
  return { result, applied };
}
