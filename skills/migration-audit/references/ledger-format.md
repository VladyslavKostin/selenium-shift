# Ledger and async-plan field reference

Read this when you need to query the JSON artefacts rather than the markdown
reports — for example to filter a large suite down to the patterns that matter.

## ledger.json

```jsonc
{
  "language": "csharp",
  "summary": {
    "files": 120,
    "members": 1840,
    "callSites": 9310,      // every Selenium call site found
    "distinctPatterns": 47, // how many decisions are actually needed
    "mapped": 41,
    "unmapped": 6,
    "collapseRatio": 198.1  // callSites / distinctPatterns
  },
  "byConfidence": { "high": 6200, "review": 1900, "delete": 900, "unmapped": 310 },
  "clusters": [ /* see below */ ],
  "files": [ { "file": "...", "types": 2, "members": 14, "sites": 61 } ]
}
```

### Cluster

| Field | Meaning |
|---|---|
| `id` | Stable handle, `C001`… Use it when discussing a pattern with the user. |
| `fingerprint` | Normalised shape. `$R` receiver, `$STR`/`$NUM` literals, `$ARG` identifier, `$EXPR` compound, `$LAMBDA` lambda. |
| `count` | Number of real call sites collapsed into this pattern. |
| `rule` / `rules` | Headline rule id, and every rule that matched. |
| `emit` | Replacement template. `$1` is the first captured argument. |
| `confidence` | `high` / `review` / `low` / `delete` / `unmapped`. |
| `async` | True if any matching rule makes the enclosing member async (C#). |
| `locatorSafe` | True if the result is a locator — creation is sync, so it does **not** force async. |
| `notes` | Guidance from the matching rules. Surface these to the user. |
| `samples` | Up to 3 real occurrences with file, line and enclosing member. |

`collapseRatio` is the number worth quoting: it is how many call sites each
decision covers. A ratio under about 5 means either a very small suite or a
codebase with unusually varied idioms — say so rather than reporting it flatly.

## async-plan.json

```jsonc
{
  "summary": {
    "members": 1840,
    "seeded": 410,        // directly touch a Playwright call
    "becomeAsync": 980,   // transitive closure
    "asyncShare": 53.3,
    "blocked": 31,        // cannot be made async — the real estimate
    "hierarchyGroups": 44
  },
  "members": [ /* see below */ ]
}
```

### Member entry

| Field | Meaning |
|---|---|
| `key` | `Type.Member/arity`. |
| `currentSignature` / `proposedSignature` | Before and after. Interface and abstract members get `Task` **without** `async`. |
| `reason.kind` | `playwright-call` (direct) or `calls-async` (transitive). |
| `blockers[]` | `constructor`, `property`, `iterator`, `linq-predicate`, each with a `fix`. |
| `hierarchy` | Present when the member spans several types; `spansInterface` means an interface is involved. All of them change in one commit. |

## Querying without blowing up context

Do not read either file wholesale on a real suite. Filter first:

```bash
# Only the patterns needing a human decision
node -e 'const l=require("./ledger.json");
  l.clusters.filter(c=>c.confidence==="unmapped")
    .forEach(c=>console.log(c.count, c.fingerprint))'

# Only the blockers, which are the estimate
node -e 'const p=require("./async-plan.json");
  p.members.filter(m=>m.blockers.length)
    .forEach(m=>console.log(m.file+":"+m.line, m.key, m.blockers.map(b=>b.kind).join(",")))'
```
