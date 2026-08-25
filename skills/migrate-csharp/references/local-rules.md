# Project-local rule overlay

The built-in rules cover the idioms every Selenium suite shares. They cannot
cover the ones a specific team invented — a homegrown `ElementHelper.WaitAndClick`,
a `BasePage.SafeType`, a custom attribute. Those surface as **unmapped**
patterns in the audit ledger and as **residue** after the codemod runs.

The overlay is where those decisions live. Write the decision once, commit it,
and it replays on every subsequent run at no cost. This is the difference
between a migration that costs a decision per *call site* and one that costs a
decision per *idiom* — usually two orders of magnitude apart.

## Location

`<suite-root>/.selenium-shift/rules.local.json`, or pass `--rules <path>`.
Absent file means an empty overlay, not an error.

## Format

```json
{
  "version": 1,
  "tier1": [
    {
      "id": "basepage.find-by-variable",
      "find": "\\bDriver\\.FindElement\\((\\w+)\\)",
      "replace": "$1",
      "regex": true,
      "note": "This suite passes a By around as a variable; after the By->ILocator conversion the FindElement wrapper is redundant."
    }
  ],
  "memberBody": [
    {
      "id": "helper.safe-type",
      "find": "ElementHelper.SafeType(",
      "replace": "await ElementHelper.SafeTypeAsync("
    }
  ],
  "asyncSeeds": ["ExternalHelper\\.Navigate"],
  "residueIgnore": ["// selenium-shift:ignore"]
}
```

| Field | Applied | Notes |
|---|---|---|
| `tier1` | File-wide, after the built-in Tier 1 pass | **May not introduce `await`** — rejected at load time |
| `memberBody` | Inside members the closure pass proved async | May introduce `await` |
| `asyncSeeds` | Regexes; a member whose body matches becomes an async seed | For helpers defined outside the scanned tree |
| `residueIgnore` | Substrings; matching lines are exempt from residue checks | For deliberate leftovers |

`find` is a literal substring unless `regex: true`. `replace` uses `$1`-style
capture references. `flags` overrides the default `g`.

## Why tier1 rules cannot introduce await

Tier 1 runs across the whole file with no knowledge of which member each match
lands in — it cannot tell a synchronous property getter from an async method.
An `await` injected there lands inside property getters and does not compile.
Member-body rules run only inside members the closure pass already proved
async, which is why they are allowed to.

If the loader rejects a rule for this reason, move it to `memberBody`.

## Writing rules from residue

The codemod's residue report groups by marker and counts sites. Get the actual
sites with `--report <path>` and grep that file — do not read the suite's
source files to find them.

One rule per *idiom*, not per site. If two residue groups have the same shape
with different names, write one regex covering both. Prefer a narrow `find`
that fails visibly over a broad one that silently corrupts unrelated code —
residue is reported, a bad rewrite is not.
