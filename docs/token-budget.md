# Token budget

This plugin exists to make a migration cheap in human attention. When an agent
drives it, the same design makes it cheap in tokens — for one reason:

> **Source code never round-trips through the context window.**

The codemod reads files from disk and writes them back to disk. The agent sees
a summary. A migration of 200 files costs about the same in context as a
migration of 5, because the agent reads neither.

Everything below follows from that.

## Where the tokens actually go

Not into the skill body, which is read once. They go into:

1. **Reading source files** to decide what to change.
2. **Writing files back out** — output tokens, several times the unit cost of
   input, and the slowest part of any turn.
3. **Script output**, which becomes input tokens on the next turn *and every
   turn after it*, because it stays in the transcript.

(1) and (2) are eliminated by the codemod. (3) is a design constraint on this
repo's CLI tools.

## The output budget

Every line a tool prints is paid for repeatedly. So:

- **Grouped counts, never per-site enumeration.** `migrate-unified.mjs`
  reports `4 blockers` by kind, not four blocks of prose with file paths.
- **Decisions first.** `inventory.mjs` sorts unmapped and low-confidence
  patterns to the top and truncates the `auto` ones, because a pattern that
  needs no decision is the least useful thing to spend attention on.
- **Detail goes to a file.** `--report <path>` writes per-site detail as
  markdown. An agent working one blocker greps that file for that blocker.
  An agent that does not need it pays nothing.
- **No decoration.** Banners, progress lines, emoji headers and
  self-congratulatory summary statistics are all tokens.

Target: a default run prints under 25 lines regardless of suite size.

Measured against the bundled fixture (5 files, 185 lines of C#) and a
synthetic suite 16× its size (81 files, 3,396 lines):

| Command | 5 files | 81 files |
|---|---|---|
| `migrate-unified.mjs --dry-run` | 17 lines / 1,061 B | 17 lines / 1,069 B |
| `async-predict.mjs` | 20 lines / 1,078 B | 20 lines / 1,084 B |
| `inventory.mjs` | 32 lines / 1,757 B | 30 lines / 1,623 B |

The inventory shrinks slightly on the larger suite because its pattern table
is capped and the larger suite has proportionally fewer distinct patterns —
which is the clustering thesis restated as an output property.

## Where model tokens *should* go

Two places, and the whole design is about protecting them:

- **Deciding unmapped patterns**, once each, into
  `.selenium-shift/rules.local.json`. Committed, so the second run is free.
- **Resolving blockers**, which need real judgement about a specific codebase.

Both scale with the number of distinct *idioms* in a suite — roughly flat —
rather than with its line count. That is the entire economic argument for
auditing before migrating.

## What not to do

- Don't read the suite's files to plan the codemod run. It reads them itself.
- Don't hand-edit sites the codemod flagged as residue. Write one overlay rule
  and re-run; there are almost always more sites than the summary shows.
- Don't re-read migrated files to verify them. Build, and read the compiler's
  errors.
- Don't quote token-savings figures at users. The savings are real and depend
  entirely on suite shape; a specific multiplier is a number someone made up.
