---
name: emit-typescript
description: Cross-language scaffold generator that turns Java or C# Selenium tests into a Playwright TypeScript starting point when the team is deliberately changing language. Produces a reviewable skeleton with TODO markers, NOT a verified migration — there is no compilation guarantee. Use only when the user explicitly asks to move Selenium tests to TypeScript or JavaScript Playwright. If they want to stay in their current language, use migrate-java or migrate-csharp instead.
---

# Emit TypeScript scaffold

Cross-language generation from a Java or C# Selenium suite to Playwright
TypeScript.

## Read this before using the skill

This mode is **categorically weaker** than the same-language migrations, and
saying so up front is part of the job.

| | Same-language | This skill |
|---|---|---|
| Type resolution | Available | Not available |
| Verification | Compiles, or fails loudly | No compile check possible |
| Output status | Migration | Starting point |

Without the original project's references, generic types, inherited members and
anything resolved through a base class or DI container cannot be resolved. The
output is a scaffold with structure and locators carried across, and `TODO`
markers where information was missing.

State this plainly before generating anything. If the user assumes parity with
the same-language path and finds out later, the tool has cost more than it saved.

## When this is the right call

Only when the team is **deliberately** changing language — usually because the
app under test is already TypeScript and they want tests in the same stack.

It is the wrong call when the suite is coupled to NuGet or Maven packages, when
domain entities are shared between tests and production code, or when the QA
team does not write TypeScript. In those cases say so and point at
`migrate-csharp` or `migrate-java`. A working Java suite beats an abandoned
TypeScript one.

## Workflow

1. Run `migration-audit` on the source suite for the pattern ledger.
2. Generate the target skeleton: `playwright.config.ts`, fixtures, and a
   `pages/` directory mirroring the source package structure.
3. For each source page object, emit a TypeScript class with locators carried
   across from the ledger and Selenium calls translated where a rule matched.
4. Insert `// TODO: unresolved — <what was missing>` wherever a type could not
   be resolved. Never guess a type to make the output look finished; an
   unmarked wrong guess is worse than a marked gap.
5. Report the TODO count alongside the file count. That number is the remaining
   work, and it is the honest headline.

## Output conventions

- TypeScript targets are async: every locator action is awaited.
- Locator creation stays sync — `page.getByRole(...)` needs no await, only the
  action does.
- Prefer `getByRole`/`getByLabel` over the source's XPath where the source
  locator carried enough semantic information; otherwise carry it verbatim and
  mark it.
- One `test.describe` per source test class, one `test` per source test method,
  keeping original names so coverage can be compared against the old suite.
