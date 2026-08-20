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
if (blocked.length) {
  console.log("  Blockers\n  " + "-".repeat(60));
  for (const m of blocked) {
    console.log(`  ${m.file}:${m.line}  ${m.type}.${m.name}`);
    for (const b of m.blockers) console.log(`      [${b.kind}] ${b.fix}`);
    console.log();
  }
}

const clean = plan.members.filter((m) => !m.blockers.length);
if (clean.length) {
  console.log(`  Mechanical signature changes (${clean.length})\n  ` + "-".repeat(60));
  for (const m of clean.slice(0, 15)) {
    console.log(`  ${m.file}:${m.line}`);
    console.log(`      -  ${m.currentSignature}`);
    console.log(`      +  ${m.proposedSignature}`);
  }
  if (clean.length > 15) console.log(`  ... and ${clean.length - 15} more\n`);
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
