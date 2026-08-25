# Tiers and blockers — C#

Background for the migration. Read when resolving a blocker, or when a rewrite
the codemod produced looks wrong and you need to know what it was aiming for.

The tiers run in order, and the order is not negotiable: the async pass needs
to know which calls became async, so it runs last. `migrate-unified.mjs` does
Tier 1 and Tier 3; Tier 2 is structural and stays manual.

## Tier 1 — local rewrites

Expression-level swaps that depend on nothing around them.

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
of the call graph that never becomes async. This is the load-bearing rule of
the whole design — the `locatorSafe` flag in `packages/rules/csharp.json`
marks the rules it applies to.

Delete rather than translate: `WebDriverWait`, `ExpectedConditions`,
`ImplicitWait`, `Thread.Sleep`. Playwright auto-waits. Translating
`Thread.Sleep(2000)` into `WaitForTimeoutAsync(2000)` preserves exactly the
flakiness the migration was meant to remove.

## Tier 2 — structural rewrites

Whole-file changes, not patches. Rewrite the file from the target shape rather
than editing toward it. The codemod does not attempt these.

- Driver lifecycle disappears. `new ChromeDriver()` in `[SetUp]` and `Quit()`
  in `[TearDown]` are replaced by inheriting `PageTest`, which supplies `Page`.
- `[SetUp]`/`[TearDown]` that only managed the browser get deleted outright.
- Page-object constructors taking `IWebDriver` take `IPage` instead.
- Page Factory attributes (`[FindsBy]`) have no equivalent; those fields
  become `ILocator` properties.

## Tier 3 — async closure

What the codemod applies, and what to check if it looks wrong:

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

## Blockers — never resolved automatically

The codemod reports these and changes nothing about them. Each needs a human
decision; guessing produces code that compiles but deadlocks or silently skips
work.

| Blocker | Why | Usual resolution |
|---|---|---|
| Constructor | Cannot be async | Async factory method, or move the work into the fixture |
| Property | C# properties cannot be async | Return `ILocator` and stay sync, or convert to a method |
| Iterator (`yield return`) | Cannot combine with `async` normally | `IAsyncEnumerable<T>`, or materialise the sequence |
| LINQ predicate | Cannot `await` inside a lambda | Rewrite as an explicit `foreach` |

Never resolve a blocker with `.Result` or `.Wait()`. It compiles, and it will
deadlock or reintroduce the flakiness the migration was meant to remove.

If a blocker has no clean resolution, leave the member unmigrated and report
it — a suite that is 90% migrated and honest beats one that is 100% migrated
and lying.

## Locator quality

XPath locators are carried forward at `low` confidence. They keep working, so
migrating them verbatim is tempting — but a suite that arrives in Playwright
still driven by `//div[@class='x']//button[3]` has changed frameworks without
getting more reliable. Offer to convert the worst offenders to `GetByRole` or
`GetByText`, and be explicit that this is a rewrite requiring the running app,
not a mechanical translation.
