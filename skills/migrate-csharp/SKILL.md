---
name: migrate-csharp
description: Migrate a C# Selenium test suite to Playwright for .NET, staying in C# — no rewrite to TypeScript. Handles the async propagation that makes this migration hard: Playwright .NET is async-only, so every method reaching a Playwright call becomes async and so does every caller. Use whenever the user wants to convert, port or migrate C#, .NET, NUnit, MSTest or xUnit Selenium tests to Playwright, mentions Microsoft.Playwright or Playwright .NET, or asks about async/await, Task return types, or await propagation in a test migration. Run migration-audit first.
---

# Migrate C# Selenium to Playwright .NET

Language-preserving migration. The output is C#, because the team's NuGet
packages, domain entities and people are all C#, and rewriting into TypeScript
throws that away to solve a problem nobody has.

**Playwright for .NET has no synchronous API.** Selenium's C# binding is
synchronous. So this is not a syntax swap — it is a whole-program
transformation, because `async` is viral in C#.

The codemod does the mechanical part. Your judgement goes into the two places
it cannot go: deciding this codebase's own idioms, and resolving blockers.
Both are decided once and then replay for free.

## Workflow

### 1. Audit, if it hasn't been run

`migration-audit` produces the pattern ledger. Skip this only when it has
already been run for this suite in this session — its whole value is telling
you how many *distinct* decisions the suite needs before you start making them
one file at a time.

### 2. Migrate

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/migrate-unified.mjs <suite-dir> --dry-run
```

This applies Tier 1 (types, locators, dead waits) and Tier 3 (async signatures
and member bodies) in one pass, and reports grouped counts. Show the user the
summary and let them approve before dropping `--dry-run` to write.

Do not read the suite's files into context to plan this step, and do not edit
them by hand afterwards. The codemod reads and writes on disk; reading the
files yourself costs many times more and produces the same edits.

### 3. Resolve what the codemod reported

Two buckets, both needing a decision:

- **Residue** — Selenium code that survived, meaning no rule matched it. This
  is usually a project-specific idiom (a `BasePage` helper, a custom wrapper).
  Decide it once in the project's rule overlay and re-run — see
  `references/local-rules.md`. Do not hand-edit the sites; there are usually
  more of them than the report shows.
- **Blockers** — members that cannot be made async at all. These need real
  judgement per member, and this is where your tokens should go. See
  `references/tiers.md`.

Add `--report <path>` to get per-site detail as a file, then grep it for the
one blocker you are working on rather than printing all of them.

### 4. Finish Tier 2 by hand

The codemod does not do these, by design — they are structural, not textual:

- `[SetUp]`/`[TearDown]` driver lifecycle becomes inheritance from `PageTest`.
- Call sites in *other* members that invoke a now-renamed async method still
  need `await`.

### 5. Verify

`dotnet build`, then confirm no `Thread.Sleep`, `WaitForTimeoutAsync`,
`.Result` or `.Wait()` survives. Fix compile errors from the build output —
do not re-read the migrated files to check them.

A build that passes but still contains waits means the conversion was
mechanical rather than understood.

## Reference

- `references/tiers.md` — what each tier does and why, and the blocker table.
  Read when resolving a blocker or when a rewrite looks wrong.
- `references/local-rules.md` — the overlay format for project-specific idioms.
