# selenium-shift

**Selenium → Playwright migration that keeps your language.** Java stays Java.
C# stays C#.

A [Claude Code](https://claude.com/claude-code) plugin, plus a zero-dependency
Node CLI that works on its own.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)

---

## Why this exists

Every other Selenium→Playwright tool converts *to* TypeScript. That is fine if
your app is TypeScript. It is useless if your suite is coupled to NuGet or Maven
packages, shares domain entities with production code, or is maintained by
people who do not write TypeScript.

Those teams get told to rewrite. Most of them don't — they stay on Selenium.

selenium-shift migrates **C# → Playwright .NET** and **Java → Playwright Java**,
in place. Cross-language output exists as a clearly-labelled secondary mode.

## Why use it

**It audits before it touches anything.** You get a reviewable ledger of every
Selenium call site in the suite, clustered into distinct idioms, before a single
file changes. Most migrations have no artefact at this stage at all — someone
just starts editing. A team can sign off on the ledger.

**It answers the question C# teams actually need answered.** Playwright for .NET
has no synchronous API ([playwright-dotnet#2715](https://github.com/microsoft/playwright-dotnet/issues/2715),
open since 2023), and Selenium's C# binding *is* synchronous. So `async` has to
propagate through the entire call graph — a fixpoint problem, not a
find-and-replace. `async-predict.mjs` computes that closure and, more usefully,
the **blockers**: members that cannot be made async at all. Constructors,
properties, iterators, LINQ predicates. Those blockers are your real estimate.

**It refuses to fake the hard parts.** No codemod can resolve a blocker
correctly without knowing your intent, so this one doesn't try. It never emits
`.Result` or `.Wait()` to make something compile — that trades a compile error
for a deadlock. A suite that is 90% migrated and honest beats one that is 100%
migrated and lying.

**It deletes waits instead of translating them.** `Thread.Sleep`,
`WebDriverWait`, `ImplicitWait` and `ExpectedConditions` are removed, not
converted. Playwright auto-waits on every action and every web-first assertion.
Translating `Thread.Sleep(2000)` into `WaitForTimeoutAsync(2000)` preserves
exactly the flakiness the migration was supposed to remove.

**It keeps synchronous things synchronous.** In Playwright .NET, *creating* a
locator is synchronous — only *acting* on one is async. Page objects are
property-heavy, so honouring this keeps async out of a large share of the
members a naive tool would rewrite. See [the rule that carries the design](#the-rule-that-carries-the-design).

**It learns your codebase's own idioms, once.** Your team's `BasePage.SafeClick`
helper isn't in anyone's rule table. Decide it once, commit the decision, and it
replays on every future run — see [project-local rules](#project-local-rules).

**It is cheap to run under an AI agent, by construction** — see
[token efficiency](#token-efficiency), which is measured rather than claimed.

## What it does not do

Stated up front, because a migration tool that overstates itself is worse than
none:

- It does **not** restructure your test fixtures. `[SetUp]`/`[TearDown]` driver
  lifecycle → `PageTest` inheritance is a structural change you (or Claude) make
  by hand.
- It does **not** resolve async blockers. It finds and classifies them.
- It does **not** guarantee the result compiles. It reports *residue* —
  Selenium code that survived — so you know exactly where it fell short.
- It does **not** improve locator quality. XPath selectors are carried forward
  and flagged `low`; converting them to `GetByRole` is a rewrite requiring the
  running app.

---

## Install

### As a Claude Code plugin

Clone the repo, then point Claude Code at it from the suite you are migrating.
Nothing is copied and nothing is written to your global config:

```bash
git clone https://github.com/VladyslavKostin/selenium-shift ~/selenium-shift

cd ~/path/to/your-selenium-suite       # the project being migrated
claude --plugin-dir ~/selenium-shift   # point at this repo
```

The four skills register for that session. Check them with `/plugin` inside
the session, or validate the plugin before committing changes to it:

```bash
claude plugin validate ~/selenium-shift
```

Skill edits take effect immediately in a running session, so this is also the
setup to use if you want to tune the rules against your own codebase.

### Standalone CLI, no Claude

Every script runs on its own. Node 18+, nothing to install:

```bash
git clone https://github.com/VladyslavKostin/selenium-shift
cd selenium-shift
npm test            # 27 assertions against the bundled fixtures
npm run demo:cs     # inventory the C# fixture
npm run demo:async  # predict async impact
```

---

## Usage

### With Claude Code

Don't invoke skills by name. They trigger from their descriptions, so describe
the task the way you actually would:

| What you say | What loads |
|---|---|
| "We're considering moving this Selenium suite to Playwright — what are we dealing with?" | `migration-audit` |
| "How much of our page-object layer becomes async under Playwright .NET?" | `migration-audit` |
| "Migrate the login page object to Playwright, staying in C#" | `migrate-csharp` |
| "Port these JUnit Selenium tests to Playwright Java" | `migrate-java` |

Claude runs the scripts itself, resolving them through `${CLAUDE_PLUGIN_ROOT}`.
The recommended order is audit → decide unmapped patterns → migrate → resolve
blockers → build.

### From the command line

```bash
# Read-only. Inventory the suite and predict the async blast radius.
node bin/inventory.mjs     ./MyTests --lang csharp --md ledger.md
node bin/async-predict.mjs ./MyTests --md async-plan.md

# Writes. Applies Tier 1 (types, locators, dead waits) and
# Tier 3 (async signatures and member bodies). Preview first.
node bin/migrate-unified.mjs ./MyTests --dry-run
node bin/migrate-unified.mjs ./MyTests --report migration.md
```

| Flag | Effect |
|---|---|
| `--dry-run` | Analyse and report, write nothing |
| `--report <path>` | Write per-site detail to a markdown file |
| `--rules <path>` | Use a rule overlay from a non-default location |
| `--verbose` | Print per-site detail to stdout instead of a file |

`async-predict.mjs` and `inventory.mjs` follow the same convention: grouped
counts on stdout, per-site detail via `--md` / `--json` (or `--verbose` to
force it to stdout).

`inventory.mjs` and `async-predict.mjs` never write to your source.
`migrate-unified.mjs` does, unless given `--dry-run`. **Commit or stash before
running it without `--dry-run`.**

### Project-local rules

The built-in rules cover the idioms every Selenium suite shares, not the ones
your team invented. Those surface as `unmapped` in the ledger and as **residue**
after a migration run.

Decide each one once, in `./MyTests/.selenium-shift/rules.local.json`, and
commit it. It then replays on every run at no cost:

```json
{
  "tier1": [
    {
      "id": "unwrap-find",
      "find": "\\bDriver\\.FindElement\\((\\w+)\\)",
      "replace": "$1",
      "regex": true,
      "note": "This suite passes By around as a variable; after By->ILocator the wrapper is redundant."
    }
  ],
  "memberBody": [
    { "id": "helper.safe-type", "find": "ElementHelper.SafeType(", "replace": "await ElementHelper.SafeTypeAsync(" }
  ]
}
```

`tier1` rules run file-wide and **may not introduce `await`** — Tier 1 cannot
tell a synchronous property getter from an async method, so the loader rejects
such rules rather than emitting code that won't compile. Put those in
`memberBody`, which only runs inside members already proven async.

Full format, including `asyncSeeds` and `residueIgnore`:
[`skills/migrate-csharp/references/local-rules.md`](skills/migrate-csharp/references/local-rules.md).

---

## Token efficiency

If you drive this with an AI agent, the thing that costs money is not the
migration — it is the **source code passing through the model's context
window**. One principle drives the whole design:

> Source code never round-trips through the context window. The codemod reads
> from disk and writes to disk. The agent sees a summary.

Two consequences, both measurable:

**1. Tool output is bounded, not proportional to suite size.** Everything is
reported as grouped counts; per-site detail goes to `--report`, which an agent
greps on demand instead of carrying in context. Reproduce it:

| Command | 5 files (185 lines of C#) | 81 files (3,396 lines of C#) |
|---|---|---|
| `migrate-unified.mjs` | 17 lines / 1,061 bytes | 17 lines / 1,069 bytes |
| `async-predict.mjs` | 20 lines / 1,078 bytes | 20 lines / 1,084 bytes |
| `inventory.mjs` | 32 lines / 1,757 bytes | 30 lines / 1,623 bytes |

A 16× larger suite cost **8 additional bytes** of context for the codemod, and
slightly *less* for the inventory. Reproduce it on your own suite with `wc`.

**2. Skill bodies are small and progressively disclosed.** The four skill
descriptions — the only part loaded in every session whether or not anything
fires — total ~2.1 KB. `migrate-csharp/SKILL.md` is 3.6 KB and loads only when
it triggers; its detailed tier and blocker reference is a further 4.5 KB that
loads only when Claude is actually resolving a blocker.

Check the real cost yourself, in-session:

```
/plugin
claude plugin details selenium-shift
```

That splits always-on from on-invoke cost. Given that this project is partly an
argument about token efficiency, it is worth keeping the number honest.

**What this deliberately does not claim:** a savings multiplier. The savings are
real, but they depend entirely on suite shape — a codebase with many custom
helpers produces more residue and needs more model involvement than one built on
stock Selenium idioms. Any specific "N% cheaper" figure is a number someone made
up. The mechanism is described in [docs/token-budget.md](docs/token-budget.md);
measure your own suite.

---

## How it works

### 1. Migrate patterns, not files

A 60k-line suite has thousands of call sites but only dozens of distinct
*idioms*. File-by-file migration rediscovers the same decision hundreds of times
— expensive, and inconsistent, because the same idiom gets translated three
different ways in three different files.

So: normalise every call site into a fingerprint, cluster, decide once per
cluster, replay everywhere.

```
driver.FindElement(By.Id("submit")).Click()     ─┐
driver.FindElement(By.Id("login")).Click()      ─┼─►  $R.FindElement(By.Id($STR)).Click()
driver.FindElement(By.Id(buttonId)).Click()     ─┘         one decision, N sites
```

Cost then scales with pattern count — roughly flat — instead of line count.

Each cluster carries a confidence level:

| Confidence | Meaning |
|---|---|
| `high` | Direct equivalent, applies without review |
| `review` | Right shape, target may be wrong for this codebase |
| `low` | Works but is still bad (XPath). Flag for rewrite |
| `delete` | Removed, not translated (waits, lifecycle) |
| `unmapped` | No rule matched — needs one human decision |

### 2. Java and C# are not the same problem

| | Java | C# |
|---|---|---|
| Playwright binding | **Synchronous** | **Async-only** |
| Method signatures | Unchanged | All rewritten |
| Call graph | Untouched | Transitively rewritten |
| Difficulty | Mechanical | Whole-program |

`async-predict.mjs` reports the closure and the blockers:

```
  members analysed        26
  directly touch Playwright 11
  become async            16  (61.5% of all members)
  cannot be made async    4  <- human work
  cross-type groups       4  (must change together)
```

Those four blockers are the real estimate. No codemod fixes them.

### The rule that carries the design

In Playwright .NET, **creating a locator is synchronous** — only *acting* on one
is async. So an element property stays a property:

```csharp
public IWebElement SubmitButton => _driver.FindElement(By.Id("submit"));   // Selenium
public ILocator    SubmitButton => Page.GetByTestId("submit");             // still sync
```

Every property kept synchronous is a subtree of the call graph that never
becomes async. It is encoded as `locatorSafe` in `packages/rules/*.json` and
pinned by four regression tests.

---

## Limits

- **The parser is structural, not semantic.** It resolves shapes, not types.
  That is enough to audit a suite, predict async impact, and apply mechanical
  rewrites — it is *not* enough to safely rewrite a large C# codebase
  unattended. Production-grade rewriting wants Roslyn
  (`CSharpSyntaxRewriter` + `MSBuildWorkspace`), which needs the .NET SDK.
- **The call graph matches on simple names.** Two same-named methods on
  unrelated types are treated as one node, which over-approximates. It errs
  toward reporting *more* async impact than real — the safe direction for an
  estimate.
- **Tier 2 is manual by design.** Fixture and page-object restructuring is
  structural, not textual, and templating it badly is worse than not templating
  it. The skills guide it; the codemod does not attempt it.
- **Cross-language output is a scaffold, not a migration.** No type resolution,
  no compile guarantee. See [`skills/emit-typescript/SKILL.md`](skills/emit-typescript/SKILL.md).
- **Always review the diff.** `git diff` after a run. This is a codemod, not an
  oracle.

## Layout

```
.claude-plugin/         plugin + marketplace manifests
skills/                 migration-audit, migrate-java, migrate-csharp, emit-typescript
packages/core/          masker, scanner, chain fingerprinting, ledger, local-rule overlay
packages/csharp-async/  the async closure engine
packages/rules/         Selenium → Playwright mapping rules per language
bin/                    CLI entry points
docs/                   cost model and output-budget rationale
fixtures/               C# and Java suites containing every hard case on purpose
test/                   27 regression assertions
```

## Contributing

```bash
npm test
```

The fixtures under `fixtures/` contain every hard case on purpose — locator
properties that must stay synchronous, an iterator blocker, a LINQ-predicate
blocker, an interface whose implementers must change together. If you change a
rule, the tests will tell you which invariant you broke.

New mapping rules go in `packages/rules/*.json` with an honest `confidence`
value. Rules that need a human decision should be marked `review` or left
unmapped rather than guessing — an unmapped pattern is reported, a wrong rule
is silent.

Skill edits take effect immediately in a running Claude session, so you can
watch a skill misfire, fix the wording, and re-ask in the same conversation.
Changes to `plugin.json` need `/reload-plugins`.

## Roadmap

1. Tier 2 templating for the common NUnit/xUnit fixture shapes.
2. Roslyn backend for C# so rewrites are type-aware rather than structural.
3. Java writer parity with the C# codemod.
4. TypeScript emitter beyond scaffold quality.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Vladyslav Kostin.
