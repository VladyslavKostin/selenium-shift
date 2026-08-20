#!/usr/bin/env node
/**
 * selenium-shift inventory
 *
 * Scans a Selenium suite and writes a migration ledger: every call site
 * collapsed into distinct patterns, each annotated with the rule that handles
 * it. Costs nothing to run and touches no files.
 *
 * Usage:
 *   node bin/inventory.mjs <dir> --lang csharp [--json out.json] [--md out.md]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { buildLedger } from "../packages/core/ledger.mjs";

const EXT = { csharp: ".cs", java: ".java" };
const SKIP = new Set(["node_modules", "bin", "obj", "target", ".git", "build", "out"]);

function walk(dir, ext, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, acc);
    else if (extname(full) === ext) acc.push(full);
  }
  return acc;
}

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = process.argv[2];
if (!root) {
  console.error("usage: inventory.mjs <dir> --lang <csharp|java> [--json out.json] [--md out.md]");
  process.exit(1);
}

const lang = arg("--lang", "csharp");
if (!EXT[lang]) { console.error(`unknown language: ${lang}`); process.exit(1); }

const files = walk(root, EXT[lang]).map((path) => ({
  path: relative(process.cwd(), path),
  src: readFileSync(path, "utf8"),
}));

if (!files.length) { console.error(`no ${EXT[lang]} files under ${root}`); process.exit(1); }

const ledger = buildLedger(files, lang);
const s = ledger.summary;

console.log(`\n  selenium-shift inventory — ${lang}\n`);
console.log(`  files            ${s.files}`);
console.log(`  members          ${s.members}`);
console.log(`  Selenium sites   ${s.callSites}`);
console.log(`  distinct patterns ${s.distinctPatterns}`);
console.log(`  collapse ratio   ${s.collapseRatio}x  (sites per decision)`);
console.log(`  unmapped         ${s.unmapped} pattern(s) need a human decision\n`);

const label = { high: "auto", review: "review", low: "rewrite", delete: "delete", unmapped: "DECIDE" };
console.log("  pattern                                                     n  action");
console.log("  " + "-".repeat(74));
for (const c of ledger.clusters.slice(0, 25)) {
  const fp = c.fingerprint.length > 54 ? c.fingerprint.slice(0, 51) + "..." : c.fingerprint;
  console.log(`  ${fp.padEnd(54)} ${String(c.count).padStart(4)}  ${label[c.confidence] ?? c.confidence}`);
}
if (ledger.clusters.length > 25) console.log(`  ... and ${ledger.clusters.length - 25} more\n`);

const jsonOut = arg("--json");
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(ledger, null, 2)); console.log(`\n  ledger  -> ${jsonOut}`); }

const mdOut = arg("--md");
if (mdOut) { writeFileSync(mdOut, renderMarkdown(ledger)); console.log(`  report  -> ${mdOut}`); }
console.log();

function renderMarkdown(l) {
  const lines = [
    `# Migration ledger — ${l.language}`,
    ``,
    `Generated ${l.generatedAt}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Files | ${l.summary.files} |`,
    `| Members | ${l.summary.members} |`,
    `| Selenium call sites | ${l.summary.callSites} |`,
    `| Distinct patterns | ${l.summary.distinctPatterns} |`,
    `| Collapse ratio | ${l.summary.collapseRatio}x |`,
    `| Patterns needing a decision | ${l.summary.unmapped} |`,
    ``,
    `Every call site below is one of ${l.summary.distinctPatterns} patterns. Decide once per`,
    `pattern; the replay pass applies each decision to all of its sites.`,
    ``,
    `## Patterns`,
    ``,
  ];
  for (const c of l.clusters) {
    lines.push(`### ${c.id} — ${c.count} site${c.count === 1 ? "" : "s"} — \`${c.confidence}\``);
    lines.push("");
    lines.push("```");
    lines.push(c.fingerprint);
    lines.push("```");
    if (c.emit) lines.push(`Becomes: \`${c.emit}\``);
    else if (c.confidence === "delete") lines.push(`**Deleted.** Not translated.`);
    else if (c.confidence === "unmapped") lines.push(`**No rule matched.** Needs a decision before migration.`);
    for (const n of c.notes || []) lines.push(`\n> ${n}`);
    lines.push("");
    lines.push(`Seen at:`);
    for (const s of c.samples) lines.push(`- \`${s.file}:${s.line}\` in \`${s.member}\` — \`${s.text}\``);
    lines.push("");
  }
  return lines.join("\n");
}
