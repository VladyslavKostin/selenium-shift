---
name: migrate-csharp
description: Migrate a C# Selenium test suite to Playwright for .NET, staying in C# — no rewrite to TypeScript. Handles the async propagation that makes this migration hard: Playwright .NET is async-only, so every method reaching a Playwright call becomes async and so does every caller. Use whenever the user wants to convert, port or migrate C#, .NET, NUnit, MSTest or xUnit Selenium tests to Playwright, mentions Microsoft.Playwright or Playwright .NET, or asks about async/await, Task return types, or await propagation in a test migration. Run migration-audit first.
---

# Migrate C# Selenium to Playwright .NET

Language-preserving migration. The output is C#, because the team's NuGet
packages, domain entities and people are all C#, and rewriting into TypeScript
throws that away to solve a problem nobody has.

## The one fact that shapes everything

**Playwright for .NET has no synchronous API.** The request for one
(microsoft/playwright-dotnet#2715) has sat unaddressed since 2023. Selenium's
C# binding is synchronous. So this migration is not a syntax swap — it is a
whole-program transformation, because `async` is viral in C#.

Run the tiers in order. The order is not negotiable: the async pass needs to
know which calls became async, so it runs last.

## Tier 1 — local rewrites

Expression-level swaps that depend on nothing around them. Apply the ledger
decisions from `migration-audit`.

Getting `ILocator` right here determines how much work Tier 3 becomes. In
Playwright .NET, **creating a locator is synchronous — only acting on one is
async.** So an element property stays a property:

```csharp
// Selenium
public IWebElement SubmitButton => _driver.FindElement(By.Id("submit"));

// Correct — still a synchronous property
public ILocator SubmitButton => Page.GetByTestId("submit");

// Wrong — needless, and it drags async into every caller
public async Task<ILocator> GetSubmitButtonAsync() => ...
```

Page objects are property-heavy. Every property kept synchronous is a subtree
of the call graph that never becomes async.

Delete rather than translate: `WebDriverWait`, `ExpectedConditions`,
`ImplicitWait`, `Thread.Sleep`. Playwright auto-waits. Translating
`Thread.Sleep(2000)` into `WaitForTimeoutAsync(2000)` preserves exactly the
flakiness the migration was meant to remove.

## Tier 2 — structural rewrites

Whole-file changes, not patches. Rewrite the file from the target shape rather
than editing toward it.

- Driver lifecycle disappears. `new ChromeDriver()` in `[SetUp]` and `Quit()`
  in `[TearDown]` are replaced by inheriting `PageTest`, which supplies `Page`.
- `[SetUp]`/`[TearDown]` that only managed the browser get deleted outright.
- Page-object constructors taking `IWebDriver` take `IPage` instead.
- Page Factory attributes (`[FindsBy]`) have no equivalent; those fields
  become `ILocator` properties.

## Tier 3 — async closure

Run last:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/async-predict.mjs <suite-dir> --json async-plan.json
```

Then apply the plan:

1. **Signatures.** `void M()` becomes `async Task MAsync()`; `T M()` becomes
   `async Task<T> MAsync()`.
2. **Interfaces and abstract members take no `async`.** `async` is an
   implementation detail, not part of a declaration — an interface member
   returns `Task<T>` and nothing more. Getting this wrong will not compile.
3. **Hierarchy groups change together.** A method on an interface with six
   implementers is one edit across seven files. Never split it across commits.
4. **Test methods keep their names.** The `Async` suffix is a convention for
   library APIs. Renaming `[Test] public void UserCanCheckOut` breaks every CI
   filter and report that names it. Use `[Test] public async Task UserCanCheckOut()`.
5. **Call sites get `await`.** Watch `return M()` becoming `return await M()`,
   and calls inside conditions.

## Blockers — do not "fix" these automatically

The plan lists members that cannot be made async. Each needs a human decision;
guessing produces code that compiles but deadlocks or silently skips work.

| Blocker | Why | Usual resolution |
|---|---|---|
| Constructor | Cannot be async | Async factory method, or move the work into the fixture |
| Property | C# properties cannot be async | Return `ILocator` and stay sync, or convert to a method |
| Iterator (`yield return`) | Cannot combine with `async` normally | `IAsyncEnumerable<T>`, or materialise the sequence |
| LINQ predicate | Cannot `await` inside a lambda | Rewrite as an explicit `foreach` |

Never resolve a blocker with `.Result` or `.Wait()`. It compiles, and it will
deadlock or reintroduce the flakiness the migration was meant to remove. If a
blocker has no clean resolution, leave the member unmigrated and report it — a
suite that is 90% migrated and honest beats one that is 100% migrated and lying.

## Verify

After each batch: build the project, then confirm no `Thread.Sleep`,
`WaitForTimeoutAsync`, `.Result` or `.Wait()` survives. A build that passes but
still contains waits means the conversion was mechanical rather than understood.
