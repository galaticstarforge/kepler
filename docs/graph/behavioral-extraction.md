# Behavioral Extraction

Behavioral extraction adds statically derivable facts about what code *does* to the graph. These are distinct from structural metrics (which describe topology) and from semantic summaries (which describe meaning). Behavioral extraction is about observable code effects: does this function do I/O, does it throw, what config keys does it read, what external services does it call.

The value is the same: shifting questions off LLM inference and onto Cypher. "Find all functions that write to DynamoDB" becomes a graph traversal, not a model question. "What can this symbol throw" becomes a `THROWS` edge walk.

Most of the extraction is done by analysis passes on top of the existing AST primitives. Some requires git log mining.

---

## Property Additions to `Symbol`

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `docstring` | string | Static analysis pass | Full JSDoc or language-equivalent comment attached to the symbol. Null if absent. |
| `hasIO` | boolean | Behavioral analysis pass | True if the symbol performs file reads/writes, network calls, process spawning, stdin/stdout access, or any observable I/O |
| `hasMutation` | boolean | Behavioral analysis pass | True if the symbol writes to state outside its own scope (instance fields, module-level variables, arguments passed by reference) |
| `isPure` | boolean | Behavioral analysis pass | True iff `hasIO = false` AND `hasMutation = false` AND is not `isAsync` in a way that hides side effects. Best-effort; false negatives possible |
| `effectKinds` | string[] | Behavioral analysis pass | Enumerated subset of observed effects: `file-read`, `file-write`, `network-call`, `db-read`, `db-write`, `env-read`, `process-spawn`, `timer`, `dom-mutation` |
| `configKeysRead` | string[] | Behavioral analysis pass | String literals matching config-read patterns (e.g., `process.env.X`, `config.get('X')`) |
| `featureFlagsRead` | string[] | Behavioral analysis pass | String literals passed to recognized feature-flag check patterns (e.g., `flags.isEnabled('X')`, `launchDarkly.variation('X', ...)`) |

**On `isPure`:** false negatives are expected. Dynamic dispatch, prototype mutation, and certain async patterns make it impossible to prove purity statically. Treat `isPure = true` as a strong signal and `isPure = false` as neutral.

---

## Property Additions to `Module`

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `docstring` | string | Static analysis pass | Module-level JSDoc comment, if present |

---

## Edge Types Added

### `THROWS` (Symbol → ErrorFlow)

Links a symbol to error-handling constructs it can surface. "Can surface" means: the symbol itself has a `throw` statement with that error type, or it calls another symbol that has a `THROWS` edge and does not catch it.

| Property | Type | Notes |
|---|---|---|
| `propagated` | boolean | True if this edge was inferred by transitive propagation, not direct `throw` |
| `confidence` | string | `exact` (direct throw), `inferred` (propagated), `heuristic` |

**How it's populated:** the behavioral analysis pass walks the AST for `throw` statements and error class instantiations, then propagates transitively through the `CALLS` graph up to a configurable depth (default: 5 hops). This is intentionally shallow: deep transitive propagation produces too much noise.

### `CATCHES` (Symbol → ErrorFlow)

Links a symbol to error types it explicitly handles.

| Property | Type | Notes |
|---|---|---|
| `catchBlock` | string | Raw catch clause text, truncated to 200 chars |

### `READS_CONFIG` (Symbol → ConfigItem)

Links a symbol to the config items it reads at runtime.

`ConfigItem` is an existing v1 cloud primitive. This edge makes the dependency between code and configuration queryable directly.

| Property | Type | Notes |
|---|---|---|
| `accessPattern` | string | `direct` (literal key), `dynamic` (computed key, confidence lower) |
| `confidence` | string | `exact`, `heuristic` |

### `READS_FLAG` (Symbol → FlagDefinition)

Links a symbol to the feature flag checks it performs.

`FlagDefinition` is a new node (see below).

| Property | Type | Notes |
|---|---|---|
| `checkKind` | string | `is-enabled`, `variant`, `kill-switch` |

### `CALLS_SERVICE` (Symbol → ExternalService)

Links a symbol to named external services it calls. Detection is heuristic: the pass looks for HTTP client usage, SDK constructor patterns, and string literals matching service endpoint patterns.

`ExternalService` is a new node (see below).

| Property | Type | Notes |
|---|---|---|
| `protocol` | string | `http`, `grpc`, `amqp`, `graphql` |
| `confidence` | string | `exact` (SDK named import), `heuristic` (URL pattern match) |

### `TEST_ASSERTS` (TestSymbol → Symbol)

Links a test function to the production symbols it exercises. Establishes test-to-production traceability at the symbol level, not just the file level.

| Property | Type | Notes |
|---|---|---|
| `assertionExamples` | string[] | At most 3 representative assertion strings from the test body, truncated to 200 chars each |
| `testFile` | string | Path to the test module |
| `coverageKind` | string | `unit`, `integration`, `e2e`; inferred from path conventions |

**How it's populated:** the base extractor already identifies test files via path conventions (`*.test.ts`, `*.spec.ts`, `__tests__/**`). The behavioral pass traces `CallSite` resolutions from within test symbols to production symbols and adds `TEST_ASSERTS` edges. Assertion text is extracted from common assertion patterns (`expect(x).toBe(y)`, `assert.equal(x, y)`, `t.deepEqual(...)`) and attached as properties.

---

## Node Types Added

### `FlagDefinition`

A named feature flag reference found in the codebase.

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `name` | string | Behavioral analysis pass | The flag key string |
| `repo` | string | Behavioral analysis pass | |
| `providerHint` | string | Behavioral analysis pass | Inferred flag provider: `launchdarkly`, `unleash`, `growthbook`, `custom`; best-effort |

**Index:**

```cypher
CREATE INDEX flag_name IF NOT EXISTS FOR (f:FlagDefinition) ON (f.repo, f.name);
```

### `ExternalService`

A named external service the codebase calls.

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `name` | string | Behavioral analysis pass | Normalized service name: `stripe`, `sendgrid`, `dynamodb`, `postgres`, etc. |
| `repo` | string | Behavioral analysis pass | |
| `protocol` | string | Behavioral analysis pass | Primary observed protocol |
| `detectionMethod` | string | Behavioral analysis pass | `sdk-import`, `url-pattern`, `client-constructor` |

**Index:**

```cypher
CREATE INDEX external_service_name IF NOT EXISTS FOR (e:ExternalService) ON (e.repo, e.name);
```

---

## Extraction Implementation

The behavioral analysis pass is a standard analysis pass registered in the orchestrator. It runs after the base JS extractor and requires the base extractor's output to be present.

### Docstring extraction

The pass walks `Symbol` → `Comment` (via `CONTAINS`) and looks for `Comment.kind = 'jsdoc'` immediately preceding the symbol's line range. The comment text is cleaned of `/** */` delimiters and tag noise, then stored as `Symbol.docstring`. This is a presentation-friendly representation of the existing `Comment` node content.

### Effect classification

The pass traverses the AST of each symbol (read from the source file via `SourceAccess`) and applies a set of pattern rules:

- **I/O:** matches against a pattern library of known I/O APIs: `fs.*`, `net.*`, `http.*`, `fetch`, `XMLHttpRequest`, `require('child_process')`, AWS SDK clients, database client constructors.
- **Mutation:** detects writes to `this.*`, `exports.*`, module-level `let`/`var` (detected via scope traversal), and pass-by-reference argument mutation patterns.
- **Config reads:** matches `process.env.X`, `config.get('X')`, `dotenv`, and configurable custom patterns from the plugin ecosystem.
- **Feature flags:** matches against a configurable list of flag-check call signatures. Defaults include LaunchDarkly, Unleash, GrowthBook. Custom patterns are added via plugin config.

**The pattern library is pluggable.** Plugins register behavioral patterns via the plugin manifest's `behavioralPatterns` field. This is how AWS SDK calls get classified as `db-read/write` vs generic `network-call` based on the specific SDK client used.

### Test-to-production linkage

The pass identifies test symbols (by file path convention) and traces their outgoing `CallSite` → `CALLS` → `Symbol` relationships. The first 10 distinct production symbols reachable within 2 hops from test function call sites are linked via `TEST_ASSERTS`. Assertion text extraction uses a small set of regex patterns against the raw symbol source text.

**Coverage kinds** are inferred from path conventions: `*.e2e.*` or `e2e/` → `e2e`, `*.integration.*` or `integration/` → `integration`, everything else → `unit`. These conventions are configurable per-repo in `repos.yaml`.

---

## What Becomes Cypher-Answerable

After behavioral extraction runs:

```cypher
// What functions in the payment service write to the database?
MATCH (s:Symbol {service: 'payment-gateway'})
WHERE 'db-write' IN s.effectKinds
RETURN s.name, s.filePath, s.line

// What can processPayment throw?
MATCH (s:Symbol {name: 'processPayment'})-[:THROWS]->(e:ErrorFlow)
RETURN e.errorType, e.kind

// Which feature flags gate this codepath?
MATCH (entry:Symbol {name: 'submitOrder'})-[:CALLS*1..5]->(s:Symbol)
      -[:READS_FLAG]->(f:FlagDefinition)
RETURN DISTINCT f.name

// What services does the order service call?
MATCH (s:Symbol)-[:CALLS_SERVICE]->(e:ExternalService)
WHERE s.filePath STARTS WITH 'order-service/'
RETURN DISTINCT e.name, e.protocol

// Which production functions have no test coverage?
MATCH (s:Symbol)
WHERE s.isExported = true AND s.kind = 'function'
  AND NOT exists { MATCH ()-[:TEST_ASSERTS]->(s) }
RETURN s.name, s.filePath
```

---

## Failure Modes

**Dynamic patterns produce false negatives.** Config keys computed at runtime (`config.get(buildKey(env, feature))`) will not be detected. `configKeysRead` is an undercount when key names are dynamic. This is expected. Surface the uncertainty in queries by filtering on `confidence = 'exact'` when precision matters.

**SDK detection requires pattern maintenance.** The pattern library needs to be updated as new SDKs and patterns emerge. This is a maintenance cost. Plugins share the burden, but the core library needs to stay current with common patterns.

**Transitive throws propagation is noisy at depth.** Three-hop transitive propagation is useful; ten-hop is mostly noise. The default depth of 5 is a balance. Above that, nearly every async function shows up as potentially throwing `Error` through `Promise.reject`, which is technically correct but useless for retrieval. Keep the depth at 5 unless there's a specific reason to increase it.

**Test coverage edges assume conventional file organization.** Projects that colocate tests and source without clear naming conventions will have poor `TEST_ASSERTS` coverage. This is a documentation gap, not a bug. The per-repo `testPathPatterns` config key in `repos.yaml` is where custom conventions get declared.
