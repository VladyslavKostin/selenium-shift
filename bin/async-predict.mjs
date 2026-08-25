#!/usr/bin/env node
/**
 * selenium-shift async-predict
 *
 * Answers, before anyone edits a file: if this C# Selenium suite moves to
 * Playwright .NET, which methods become async, and which of them *cannot*?
 *
 * Run this during the audit. The blocker list is the real estimate — those are
 * the members no codemod can fix, and they are what the migration will actually
 * cost in human hours.
 *
 * Usage:
 *   node bin/async-predict.mjs <dir> [--json out.json] [--md out.md]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { analyse } from "../packages/csharp-async/closure.mjs";

const SKIP = new Set(["node_modules", "bin", "obj", "target", ".git", "build", "out"]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (extname(full) === ".cs") acc.push(full);
  }
  return acc;
}

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = process.argv[2];
if (!root) { console.error("usage: async-predict.mjs <dir> [--json out.json] [--md out.md]"); process.exit(1); }

const files = walk(root).map((path) => ({
  path: relative(process.cwd(), path),
  src: readFileSync(path, "utf8"),
}));
if (!files.length) { console.error(`no .cs files under ${root}`); process.exit(1); }

const plan = analyse(files);
const s = plan.summary;

console.log(`\n  selenium-shift async-predict — C# / Playwright .NET\n`);
console.log(`  members analysed        ${s.members}`);
console.log(`  directly touch Playwright ${s.seeded}`);
console.log(`  become async            ${s.becomeAsync}  (${s.asyncShare}% of all members)`);
console.log(`  cannot be made async    ${s.blocked}  <- human work`);
console.log(`  cross-type groups       ${s.hierarchyGroups}  (must change together)\n`);

const blocked = plan.members.filter((m) => m.blockers.length);
const clean = plan.members.filter((m) => !m.blockers.length);
const verbose = process.argv.includes("--verbose");

// Grouped counts by default. Per-site detail is what --md is for: a reader
// working one blocker greps that file, and a reader who does not need it pays
// nothing to skip it. Printing every site here would make the console output
// scale with suite size, which is the one thing it must not do.
if (blocked.length) {
  const byKind = new Map();
  for (const m of blocked) {
    const kind = m.blockers[0].kind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(m);
  }
  console.log("  Blockers — each needs a human decision\n  " + "-".repeat(60));
  for (const [kind, items] of byKind) {
    console.log(`  ${String(items.length).padStart(4)}  ${kind}`);
    console.log(`        ${items[0].blockers[0].fix}`);
  }
  console.log();
}

console.log(`  Mechanical signature changes: ${clean.length}`);
if (!arg("--md") && !arg("--json") && (blocked.length || clean.length)) {
  console.log(`  Pass --md <path> for per-site detail.`);
}
console.log();

if (verbose) {
  for (const m of blocked) {
    console.log(`  ${m.file}:${m.line}  ${m.type}.${m.name}  [${m.blockers[0].kind}]`);
  }
  for (const m of clean) {
    console.log(`  ${m.file}:${m.line}  ${m.currentSignature}  ->  ${m.proposedSignature}`);
  }
  console.log();
}

const jsonOut = arg("--json");
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(plan, null, 2)); console.log(`\n  plan   -> ${jsonOut}`); }
const mdOut = arg("--md");
if (mdOut) { writeFileSync(mdOut, renderMarkdown(plan)); console.log(`  report -> ${mdOut}`); }
console.log();

function renderMarkdown(p) {
  const out = [
    `# Async impact — C# Selenium to Playwright .NET`,
    ``,
    `Generated ${p.generatedAt}`,
    ``,
    `Playwright for .NET has no synchronous API, so every member that reaches a`,
    `Playwright action becomes \`async\`, and so does every one of its callers.`,
    `This report is the transitive closure of that change.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Members analysed | ${p.summary.members} |`,
    `| Directly touch Playwright | ${p.summary.seeded} |`,
    `| Become async | ${p.summary.becomeAsync} (${p.summary.asyncShare}%) |`,
    `| **Cannot be made async** | **${p.summary.blocked}** |`,
    `| Cross-type groups | ${p.summary.hierarchyGroups} |`,
    ``,
    `## Blockers — these need a human`,
    ``,
  ];
  const blocked = p.members.filter((m) => m.blockers.length);
  if (!blocked.length) out.push(`None. Every affected member converts mechanically.`, ``);
  for (const m of blocked) {
    out.push(`### \`${m.type}.${m.name}\``, ``, `\`${m.file}:${m.line}\``, ``);
    for (const b of m.blockers) out.push(`- **${b.kind}** — ${b.fix}`);
    out.push(``);
  }
  out.push(`## Mechanical changes`, ``, `| Location | Current | Proposed |`, `|---|---|---|`);
  for (const m of p.members.filter((x) => !x.blockers.length)) {
    out.push(`| \`${m.file}:${m.line}\` | \`${m.currentSignature}\` | \`${m.proposedSignature}\` |`);
  }
  out.push(``);
  return out.join("\n");
}
