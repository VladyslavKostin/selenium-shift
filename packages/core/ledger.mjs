/**
 * Builds the migration ledger: every Selenium call site in the suite, collapsed
 * into a small set of distinct patterns, each annotated with the rule that will
 * handle it (or marked unmapped so a human decides once).
 *
 * The ledger is the review artefact. A team signs off on the ledger before a
 * single file is touched, which is the part of a migration that normally has no
 * artefact at all.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanFile } from "./scanner.mjs";
import { extractChains, fingerprint, touchesSelenium } from "./chains.mjs";
import { lineOf } from "./masker.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadRules(lang) {
  const path = join(here, "..", "rules", `${lang}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Compile a rule pattern into a regex.
 * `$A` matches any argument class, so `.SendKeys($A)` covers both
 * `.SendKeys($STR)` and `.SendKeys($ARG)` — the mapping is the same either way.
 */
function compile(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped
    .replace(/\\\$A\b/g, "\\$(?:STR|NUM|ARG|EXPR|LAMBDA)")
    .replace(/\\\$LAMBDA\b/g, "\\$LAMBDA")
    .replace(/\\\$R\b/g, "\\$R");
  return new RegExp(withWildcards);
}

const compiled = new WeakMap();
function compiledRules(rules) {
  if (!compiled.has(rules)) {
    compiled.set(rules, rules.rules.map((r) => ({ rule: r, re: compile(r.match) })));
  }
  return compiled.get(rules);
}

/**
 * A chain can legitimately match several rules — `FindElement(By.Css(..)).Text`
 * is a locator rule and an action rule at once. Return them all; the longest
 * match becomes the headline, but async-ness is true if *any* match is async,
 * because that is what forces the enclosing member to change.
 */
function matchRules(fp, rules) {
  const hits = compiledRules(rules)
    .filter(({ re }) => re.test(fp))
    .map(({ rule }) => rule);
  if (!hits.length) return { primary: null, all: [] };
  const primary = hits.reduce((a, b) => (b.match.length > a.match.length ? b : a));
  return { primary, all: hits };
}

export function buildLedger(files, lang) {
  const rules = loadRules(lang);
  const clusters = new Map();
  const perFile = [];
  let totalChains = 0;

  for (const { path, src } of files) {
    const scanned = scanFile(src, path, lang);
    const fileEntry = { file: path, types: scanned.types.length, members: 0, sites: 0 };

    for (const type of scanned.types) {
      fileEntry.members += type.members.length;

      for (const member of type.members) {
        if (member.bodyStart == null) continue;
        const chains = extractChains(src, scanned.masked, member.bodyStart, member.bodyEnd);

        for (const chain of chains) {
          if (!touchesSelenium(chain.text)) continue;
          totalChains++;
          fileEntry.sites++;

          const { fingerprint: fp, literals } = fingerprint(chain.text);
          if (!clusters.has(fp)) {
            const { primary, all } = matchRules(fp, rules);
            clusters.set(fp, {
              id: `C${String(clusters.size + 1).padStart(3, "0")}`,
              fingerprint: fp,
              count: 0,
              rule: primary ? primary.id : null,
              rules: all.map((r) => r.id),
              emit: primary ? primary.emit : null,
              confidence: primary ? primary.confidence : "unmapped",
              async: all.some((r) => r.async && !r.locatorSafe),
              locatorSafe: all.length > 0 && all.every((r) => r.locatorSafe),
              notes: all.map((r) => r.note).filter(Boolean),
              samples: [],
            });
          }

          const c = clusters.get(fp);
          c.count++;
          if (c.samples.length < 3) {
            c.samples.push({
              file: path,
              line: lineOf(src, chain.start),
              member: `${type.name}.${member.name}`,
              text: chain.text.replace(/\s+/g, " ").slice(0, 160),
              literals,
            });
          }
        }
      }
    }
    perFile.push(fileEntry);
  }

  const list = [...clusters.values()].sort((a, b) => b.count - a.count);

  return {
    language: lang,
    generatedAt: new Date().toISOString(),
    summary: {
      files: files.length,
      members: perFile.reduce((n, f) => n + f.members, 0),
      callSites: totalChains,
      distinctPatterns: list.length,
      mapped: list.filter((c) => c.confidence !== "unmapped").length,
      unmapped: list.filter((c) => c.confidence === "unmapped").length,
      collapseRatio: list.length ? +(totalChains / list.length).toFixed(1) : 0,
    },
    byConfidence: countBy(list, "confidence"),
    clusters: list,
    files: perFile,
  };
}

function countBy(list, key) {
  const out = {};
  for (const item of list) {
    const k = item[key];
    out[k] = (out[k] || 0) + item.count;
  }
  return out;
}
