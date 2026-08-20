# selenium-shift

Selenium → Playwright migration that **keeps your language**. Java stays Java.
C# stays C#.

A Claude Code plugin, plus a zero-dependency Node CLI you can run on its own.

---

## Why this exists

Every Selenium→Playwright tool converts *to* TypeScript. That is fine if your
app is TypeScript. It is useless if your suite is coupled to NuGet or Maven
packages, shares domain entities with production code, or is maintained by
people who do not write TypeScript. Those teams are told to rewrite. Most
of them don't, and stay on Selenium.

selenium-shift migrates C# → Playwright .NET and Java → Playwright Java, in
place. Cross-language output exists as a clearly-labelled secondary mode.

## The two ideas

### 1. Migrate patterns, not files

A 60k-line suite has thousands of call sites but only dozens of distinct
*idioms*. File-by-file migration rediscovers the same decision hundreds of
times — expensive, and inconsistent, because the same idiom gets translated
three different ways in three different files.

So: normalise every call site into a fingerprint, cluster, decide once per
cluster, replay everywhere.

```
driver.FindElement(By.Id("submit")).Click()     ─┐
driver.FindElement(By.Id("login")).Click()      ─┼─►  $R.FindElement(By.Id($STR)).Click()
driver.FindElement(By.Id(buttonId)).Click()     ─┘         one decision, N sites
```

Cost then scales with pattern count (roughly flat) instead of line count.

### 2. Java and C# are not the same problem

| | Java | C# |
|---|---|---|
| Playwright binding | **Synchronous** | **Async-only** |
| Method signatures | Unchanged | All rewritten |
| Call graph | Untouched | Transitively rewritten |
| Difficulty | Mechanical | Whole-program |

Playwright for .NET has no sync API — the request for one
([playwright-dotnet#2715](https://github.com/microsoft/playwright-dotnet/issues/2715))
has sat at P3 since 2023. Since Selenium's C# binding *is* sync, `async` has to
be propagated through the entire call graph, and that is a fixpoint problem, not
a find-and-replace.

`bin/async-predict.mjs` solves it. Nothing else in this space does.

---

## Quick start

Requires Node 18+. No dependencies to install.

```bash
git clone https://github.com/VladyslavKostin/selenium-shift
cd selenium-shift
npm test          # 20 assertions against the bundled fixtures

npm run demo:cs   # inventory the C# fixture
npm run demo:async # predict async impact
```

Against a real suite:

```bash
node bin/inventory.mjs     ./MyTests --lang csharp --md ledger.md
node bin/async-predict.mjs ./MyTests --md async-plan.md
```

Neither command writes to your source. They are read-only.

---

## Using it with Claude Code

The `npm run` scripts above are the CLI half — they work standalone, with no
Claude involved. The `skills/` directory is the other half: it teaches Claude
*when* to reach for those scripts and how to read what they produce.

### Load it

For development, don't install anything. Load the plugin for a single session:

```bash
cd ~/path/to/your-selenium-suite          # the project being migrated
claude --plugin-dir ~/path/to/selenium-shift
```

You `cd` into the **suite**, and point `--plugin-dir` at **this repo**.
Nothing is copied, nothing is written to your global config.

Verify the plugin is well-formed — do this before pushing, too:

```bash
claude plugin validate ~/path/to/selenium-shift
```

That checks `plugin.json` plus the frontmatter of all four `SKILL.md` files.
Inside a session, `/plugin` shows what actually registered.

### Use it

Don't invoke skills by name. They trigger from their `description`, so
describe the task the way you actually would:

| What you say | What loads |
|---|---|
| "We're considering moving this Selenium suite to Playwright — what are we dealing with?" | `migration-audit` |
| "How much of our page-object layer becomes async under Playwright .NET?" | `migration-audit` |
| "Migrate the login page object to Playwright, staying in C#" | `migrate-csharp` |
| "Port these JUnit Selenium tests to Playwright Java" | `migrate-java` |

Claude runs `inventory.mjs` and `async-predict.mjs` itself, resolving them
through `${CLAUDE_PLUGIN_ROOT}`.

### Check that triggering works

This is the part worth iterating on. Ask the first question above: if Claude
answers from general knowledge instead of running the inventory script, the
description is not assertive enough. Skills **undertrigger** far more often
than they overtrigger.

Then test the other direction — *"write a new Playwright test for the checkout
page"* should load nothing. A skill that fires on everything is as broken as
one that never fires.

Edits to a `SKILL.md` take effect **immediately in the running session**, so
you can watch a skill misfire, fix the wording in your editor, and re-ask in
the same conversation. Changes to `plugin.json` or other components need
`/reload-plugins`.

### Know what it costs

```bash
claude plugin details selenium-shift
```

Splits the token cost into **always-on** (the four skill descriptions, paid
every session whether or not anything fires) and **on-invoke** (paid when a
skill actually loads). Given that this project is partly an argument about
token efficiency, it is worth keeping that number honest.

---

## What you get

**`inventory.mjs`** — the migration ledger. Every call site, clustered, each
annotated with the rule that handles it and a confidence level:

| Confidence | Meaning |
|---|---|
| `high` | Direct equivalent, applies without review |
| `review` | Right shape, target may be wrong for this codebase |
| `low` | Works but is still bad (XPath). Flag for rewrite |
| `delete` | Removed, not translated (waits, lifecycle) |
| `unmapped` | No rule matched — needs one human decision |

The ledger is a review artefact. A team signs off on it *before* any file is
touched — the part of a migration that normally has no artefact at all.

**`async-predict.mjs`** — for C#, the transitive closure of async, plus the
**blockers**: members that cannot be made async at all.

```
  members analysed          26
  directly touch Playwright  9
  become async              14  (53.8% of all members)
  cannot be made async       4  <- human work
  cross-type groups          4  (must change together)
```

Those four blockers are the real estimate. No codemod fixes them.

### The rule that carries the design

In Playwright .NET, **creating a locator is synchronous** — only *acting* on one
is async. So:

```csharp
public IWebElement SubmitButton => _driver.FindElement(By.Id("submit"));   // Selenium
public ILocator    SubmitButton => Page.GetByTestId("submit");             // still a sync property
```

Page objects are property-heavy, so honouring this stops async from reaching a
large share of the members a naive tool would rewrite. It is encoded as
`locatorSafe` in `packages/rules/*.json` and pinned by four tests.

---

## Limits of the prototype

Stated plainly, because a migration tool that overstates itself is worse than
none.

- **The parser is structural, not semantic.** It resolves shapes, not types.
  That is enough to audit a suite and predict async impact — it is *not* enough
  to safely rewrite a large C# codebase unattended. Production rewriting wants
  Roslyn (`CSharpSyntaxRewriter` + `MSBuildWorkspace`), which needs the .NET SDK.
- **The call graph matches on simple names.** Two same-named methods on
  unrelated types are treated as one node, which over-approximates. It errs
  toward reporting *more* async impact than real, which is the safe direction
  for an estimate.
- **Tiers 1 and 2 are specified but not yet implemented as writers.** The rules
  and the ledger exist; the file-writing passes are next. Today the tools tell
  you what will happen and Claude performs the edits using the skills.
- **Cross-language output is a scaffold, not a migration.** No type resolution,
  no compile guarantee. See `skills/emit-typescript/SKILL.md`.

## Layout

```
.claude-plugin/     plugin + marketplace manifests
skills/             migration-audit, migrate-java, migrate-csharp, emit-typescript
packages/core/      masker, scanner, chain fingerprinting, ledger
packages/csharp-async/  the async closure engine
packages/rules/     Selenium → Playwright mapping rules per language
bin/                CLI entry points
fixtures/           C# and Java suites containing every hard case on purpose
test/               20 regression assertions
```

## Roadmap

1. Tier 1 writer — replay ledger decisions into source.
2. Tier 2 writer — template-driven fixture and page-object restructuring.
3. Roslyn backend for C# so Tier 3 can be applied, not just predicted.
4. TypeScript emitter.

## License

MIT
