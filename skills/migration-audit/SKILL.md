---
name: migration-audit
description: Audit a Selenium test suite before migrating it to Playwright — inventory every call site, collapse them into a small set of distinct patterns, and (for C#) predict exactly which methods become async and which cannot. Use this whenever the user mentions migrating, porting, converting or moving tests from Selenium to Playwright, asks how big or how hard such a migration would be, asks for a migration estimate or plan, or points at a Selenium suite and asks what is in it. Always run this before migrate-java or migrate-csharp — migrating without the ledger means rediscovering the same decision in every file.
---

# Migration audit

Produces the two artefacts a Selenium-to-Playwright migration needs before
anyone edits a file: a **pattern ledger** and, for C#, an **async impact
report**. Both are cheap, read-only, and reviewable by the whole team.

## Why audit first

A Selenium suite has thousands of call sites but only dozens of distinct
*idioms*. Migrating file by file rediscovers the same decision hundreds of
times — expensive in tokens, and inconsistent, because the same idiom gets
translated three different ways in three different files.

The ledger inverts this: cluster first, decide once per pattern, replay
everywhere. Cost then scales with the number of *patterns*, which is roughly
flat, instead of the number of *lines*, which is not.

## Workflow

### 1. Locate the suite and identify the language

Find the test project root. C# suites have `.csproj` referencing
`Selenium.WebDriver`; Java suites have `pom.xml` or `build.gradle` with
`selenium-java`. If both exist, audit them separately — they are different
migrations with different difficulty (see below).

### 2. Build the ledger

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/inventory.mjs <suite-dir> \
  --lang <csharp|java> \
  --json ledger.json --md ledger.md
```

Read the console summary. Do **not** read `ledger.json` into context wholesale
on a large suite — it is the raw artefact. Read `ledger.md`, or query the JSON
with a script.

Report to the user: total call sites, distinct patterns, the collapse ratio,
and above all the **unmapped** patterns. Unmapped patterns are the real work —
each one needs a decision from a human, and each decision then applies
everywhere automatically.

### 3. For C#, predict async impact

This step has no Java equivalent and is the most valuable output of the audit.

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/async-predict.mjs <suite-dir> \
  --json async-plan.json --md async-plan.md
```

Playwright for .NET has no synchronous API, so every method that reaches a
Playwright action becomes `async`, and so does every caller, transitively. The
report gives the closure of that change plus the **blockers** — members that
cannot be made async at all.

Lead the summary with the blocker count. Ten blockers is a week of careful
work; two hundred means the page-object layer needs redesigning first, and the
user should know that before committing to a date.

### 4. Give an honest estimate

Base it on what the tools found, not on a generic multiplier:

- **Java** — Playwright for Java is synchronous, so signatures never change and
  the call graph is untouched. Expect most patterns to convert mechanically.
- **C#** — add the async blockers, plus review time for every cross-type group
  (an interface and its implementers must change in one commit).
- **Both** — every `low`-confidence pattern (XPath locators, dialog handling)
  is a rewrite, not a translation. Count them separately.

Never promise a percentage. Report counts, and say which buckets are
mechanical and which need a person.

## Reading the output

| Confidence | Meaning |
|---|---|
| `high` | Direct equivalent. Applies without review. |
| `review` | Correct shape, but the target may be wrong for this codebase. |
| `low` | Carried forward but still bad. Flag for rewrite. |
| `delete` | Removed, not translated. Waits and lifecycle calls. |
| `unmapped` | No rule matched. Needs a human decision, once. |

`delete` surprises people, so explain it: Playwright auto-waits on every action
and every web-first assertion. An explicit wait that survives migration is a
migration bug, not a preserved behaviour. The same applies to `Thread.Sleep` —
translating it to `WaitForTimeoutAsync` preserves the flakiness the migration
was supposed to remove.

For the full field reference see `references/ledger-format.md`.

## Turning unmapped patterns into decisions

Unmapped patterns are the whole point of the audit, and for C# they have a
place to go. Each one is decided once and written into the project's rule
overlay at `<suite-root>/.selenium-shift/rules.local.json`; the codemod then
applies it to every site automatically, on this run and every future one.

Walk the user through the unmapped list, agree a rewrite per pattern, write
the overlay, and hand off to `migrate-csharp` — which reads it. See that
skill's `references/local-rules.md` for the format.

Decide per pattern, never per site. A suite with 2,000 call sites and 30
patterns needs 30 decisions; making them one file at a time makes them
hundreds of times over, and inconsistently.

## What this skill does not do

It does not modify files. If the user wants the migration performed, hand off
to `migrate-java` or `migrate-csharp`.
