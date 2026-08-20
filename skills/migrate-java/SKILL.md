---
name: migrate-java
description: Migrate a Java Selenium test suite to Playwright for Java, staying in Java — no rewrite to TypeScript. Playwright's Java binding is synchronous, so method signatures never change and this migration is far more mechanical than the C# one. Use whenever the user wants to convert, port or migrate Java, JUnit, TestNG or Maven/Gradle Selenium tests to Playwright, or mentions com.microsoft.playwright. Run migration-audit first.
---

# Migrate Java Selenium to Playwright Java

Language-preserving migration, output is Java.

## The one fact that shapes everything

**Playwright for Java is synchronous and blocking.** `page.click(...)` returns
when the click is done; there are no futures in the common path. Even
`waitForResponse` takes a callback and blocks.

This is why Java migration is dramatically easier than C#: signatures never
change, so the call graph is never touched. There is no async closure pass for
Java, and its absence is the point. Expect Tier 1 and Tier 2 only.

## Tier 1 — local rewrites

Apply the ledger decisions from `migration-audit`.

`Locator` creation is lazy and cheap, so element accessors stay accessors:

```java
// Selenium
private WebElement submitButton() {
    return driver.findElement(By.cssSelector("button[type=submit]"));
}

// Playwright — same shape, still synchronous
private Locator submitButton() {
    return page.locator("button[type=submit]");
}
```

Delete rather than translate: `WebDriverWait`, `FluentWait`,
`ExpectedConditions`, `implicitlyWait`, `Thread.sleep`. Playwright auto-waits
on every action and every `assertThat(locator)` assertion. A wait that survives
migration is a migration bug.

`Thread.sleep` never becomes `waitForTimeout` — that preserves the flakiness
the migration was meant to remove.

## Tier 2 — structural rewrites

Whole-file changes, best done from a template rather than patched:

- `WebDriver driver = new ChromeDriver()` and `driver.quit()` disappear.
  Browser lifecycle belongs to the fixture — use the JUnit 5 Playwright
  extension, or a `@BeforeAll` creating one `Browser` plus a `@BeforeEach`
  opening a `BrowserContext` per test.
- Page-object constructors take `Page` instead of `WebDriver`.
- `PageFactory.initElements` and `@FindBy` have no equivalent; those fields
  become `Locator` accessors.
- One `BrowserContext` per test gives isolation for free — this usually removes
  whatever cookie-clearing and session-reset code the suite accumulated.

## Assertions

Prefer retrying web-first assertions over reading state:

```java
// Reads once, no retry — flaky
assertTrue(page.locator(".account-menu").isVisible());

// Retries until timeout
assertThat(page.locator(".account-menu")).isVisible();
```

The ledger marks `isDisplayed()`/`getText()` inside assertions as `review` for
exactly this reason. Converting them literally works, but throws away the main
reliability benefit of the migration.

## Locator quality

XPath locators are marked `low` confidence. They keep working, so migrating
them verbatim is tempting — but a suite that arrives in Playwright still driven
by `//div[@class='x']//button[3]` has changed frameworks without getting more
reliable. Offer to convert the worst offenders to `getByRole` or `getByText`,
and be explicit that this is a rewrite requiring the running app, not a
mechanical translation.

## Verify

After each batch: compile, run the migrated tests, then confirm no
`Thread.sleep`, `waitForTimeout`, `WebDriverWait` or `implicitlyWait` survives
anywhere in the migrated files.
