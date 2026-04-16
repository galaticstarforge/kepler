# Semantic Enrichment

Semantic enrichment is the third layer of graph additions. It handles what structural metrics and behavioral extraction cannot: natural-language purpose, conceptual tags, architectural framing, and volatility signals.

Two categories of data live here. The first is derivable without an LLM: docstrings, git signals, architectural layer tags, public surface distinctions. These are extracted by static analysis and git mining passes and stored directly on existing node types. The second requires LLM generation: the `SymbolSummary` and `CommunitySummary` nodes, which are the output of the agentic summarization subsystem described in [summarization/](../summarization/).

This document covers both, because they share schema. The summarization document covers the process.

---

## Property Additions to `Symbol`

### Git-Derived Volatility Signals

All computed from `git log` against the bare clone.

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `changeFrequency` | float | Git mining pass | Changes per 30-day rolling window over the last 90 days |
| `authorCount` | integer | Git mining pass | Distinct author emails in the symbol's file over the last 12 months |
| `lastModified` | datetime | Git mining pass | Date of the most recent commit touching this file |
| `gitAge` | integer | Git mining pass | Days since the file's first commit |

**Granularity note:** these signals are file-level, not symbol-level. Attributing a git change to a specific symbol within a file requires blame-level analysis that is not practical at scale. `changeFrequency` on a symbol means "the file containing this symbol changed this often." This is a known imprecision. It is good enough for ranking symbols by volatility.

### Public Surface Annotation

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `isPublicApi` | boolean | Static analysis pass | True when: `isExported = true` AND the module is not a barrel file AND the symbol is not prefixed with `_` or tagged `@internal` in JSDoc |

This is a stricter version of `isExported`. Barrel files re-export everything; treating all re-exports as public API creates noise. `isPublicApi` differentiates "technically exported" from "intended for external consumers."

### Architectural Layer

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `architecturalLayer` | string | Layer classification pass | `api`, `service`, `domain`, `repository`, `infrastructure`, `utility`, `test`, `config`, `unknown` |

**How layers are classified:** a combination of file path heuristics (files under `routes/`, `controllers/`, `api/` → `api`; files under `services/` → `service`; files containing ORM models → `repository`) and configurable overrides in `repos.yaml`. Plugins may contribute layer classification rules.

Layer classification is coarse by default. It is designed to be useful even without any manual configuration. Teams that have invested in strict layered architecture will want to configure explicit path patterns.

### Bounded Context

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `boundedContextId` | string | Bounded context tagging pass | Identifier matching a `BoundedContext` node |

Bounded contexts are declared manually in `repos.yaml` as path prefixes or explicit module patterns. The tagging pass assigns the most specific matching context to each symbol. Symbols in ambiguous overlapping paths get the first match by declaration order.

---

## Node Types Added

### `SymbolSummary`

An LLM-generated summary of a symbol. Created by the agentic summarization subsystem. Not all symbols will have a `SymbolSummary` at any given time; coverage is tracked separately.

| Property | Type | Notes |
|---|---|---|
| `symbolFqn` | string | Fully-qualified name: `repo:filePath#symbolName` |
| `purpose` | string | One sentence. What this does. |
| `details` | string | 2-5 sentences. Implementation notes, important behavior, edge cases. |
| `sideEffects` | string | What observable state this modifies or I/O it performs. Null if pure. |
| `semanticTags` | string[] | Concept tags: `['payment', 'idempotent', 'retry-safe', 'audit-required']`. Free-form but normalized by the summarization pass. |
| `examplesFromTests` | string | 1-3 usage examples drawn from test assertions. Populated when `TEST_ASSERTS` edges exist. |
| `tier` | string | `provisional` or `canonical`. Provisional summaries are generated with limited context; canonical ones use full community context. |
| `model` | string | Model identifier used for generation: e.g., `anthropic.claude-3-5-haiku-20241022` |
| `generatedAt` | datetime | When this summary was generated |
| `contentHash` | string | BLAKE3 hash of the symbol's source text at generation time. Used to detect staleness. |
| `coverageFlags` | string[] | What was available during generation: `docstring`, `callers`, `callees`, `tests`, `community-context`, `type-edges` |
| `embedding` | float[] | Vector embedding of the concatenated `purpose + details + semanticTags` text |
| `embeddingModel` | string | Model used to produce the embedding |

**Vector index:**

```cypher
CREATE VECTOR INDEX symbol_summary_embedding IF NOT EXISTS
FOR (ss:SymbolSummary)
ON ss.embedding
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };
```

The dimension count of 1536 matches Amazon Titan Embed Text v2 and OpenAI `text-embedding-3-small`. If a different embedding model is configured, the index must be dropped and recreated with the correct dimension count. This is handled by the orchestrator on startup when the configured embedding model changes.

### `CommunitySummary`

An LLM-generated summary of a community cluster. One per `Community` node.

| Property | Type | Notes |
|---|---|---|
| `communityId` | integer | Back-reference to the `Community` node |
| `repo` | string | |
| `name` | string | A short name derived by the LLM: e.g., `"Payment Processing Core"`, `"Auth Token Lifecycle"` |
| `purpose` | string | 2-4 sentences describing what this cluster of code does and why it exists |
| `keySymbols` | string[] | FQNs of the 3-5 most important symbols in the community, by pageRank |
| `externalDependencies` | string[] | Community names or service names this community's border symbols call out to |
| `tier` | string | `provisional` or `canonical` |
| `model` | string | |
| `generatedAt` | datetime | |
| `symbolCount` | integer | Number of symbols in the community at generation time |
| `coveragePct` | float | Fraction of community symbols that had canonical `SymbolSummary` nodes available when this was generated |
| `embedding` | float[] | Vector embedding of `name + purpose + keySymbols` |
| `embeddingModel` | string | |

**Vector index:**

```cypher
CREATE VECTOR INDEX community_summary_embedding IF NOT EXISTS
FOR (cs:CommunitySummary)
ON cs.embedding
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };
```

### `BoundedContext`

A manually declared bounded context from `repos.yaml`.

| Property | Type | Notes |
|---|---|---|
| `contextId` | string | Unique identifier, e.g., `payments`, `auth`, `catalog` |
| `name` | string | Human-readable name |
| `repo` | string | |
| `description` | string | One sentence |

**Index:**

```cypher
CREATE INDEX bounded_context_lookup IF NOT EXISTS FOR (bc:BoundedContext) ON (bc.repo, bc.contextId);
```

### `ArchitecturalLayer`

A named architectural layer. Created once per layer name per repo.

| Property | Type | Notes |
|---|---|---|
| `name` | string | `api`, `service`, `domain`, `repository`, `infrastructure`, `utility`, `test`, `config` |
| `repo` | string | |

---

## Edge Types Added

### `HAS_SUMMARY` (Symbol → SymbolSummary)

Links a symbol to its generated summary. One-to-one: a symbol has at most one active `SymbolSummary`. When the summary is regenerated, the old node is replaced, not updated in place. Previous nodes can be soft-deleted by setting a `superseded: true` property if history matters.

### `HAS_COMMUNITY_SUMMARY` (Community → CommunitySummary)

Links a community to its generated summary. Same replacement semantics as `HAS_SUMMARY`.

### `SUMMARIZED_IN_CONTEXT_OF` (SymbolSummary → Community)

Records which community context was active when this summary was generated. This is important for understanding why two summaries of the same symbol differ: the community partition shifted, so the context changed. The summarization pass uses this to decide whether a summary is stale due to structural drift.

### `IN_LAYER` (Symbol → ArchitecturalLayer)

Links a symbol to its classified architectural layer.

### `IN_CONTEXT` (Symbol → BoundedContext)

Links a symbol to its bounded context.

### `GOVERNS` (Document → Symbol)

Links an ADR or governance document to the symbols it governs. This edge is declared in document frontmatter via the existing `symbols:` field and resolved by the doc enrichment cron. It is functionally equivalent to `DOCUMENTED_BY` but semantically distinct: `DOCUMENTED_BY` means "this doc describes this symbol," `GOVERNS` means "this ADR constrains how this symbol can be used or changed."

Frontmatter declaration:

```yaml
governs:
  - repo: payment-gateway
    path: src/handlers/payment.js
    name: processPayment
```

---

## Staleness Detection

A `SymbolSummary` is stale when `contentHash` does not match the current `Symbol.hash`. The orchestrator's incremental pass computes `Symbol.hash` on every file change. The summarization subsystem checks `contentHash` before using a summary and marks it stale if necessary.

A `CommunitySummary` is stale when:
- The community partition has been recomputed and community membership changed significantly (more than 20% of member symbols shifted).
- The `coveragePct` at generation time differed significantly from current coverage (more than 15 percentage points).

Stale summaries remain in the graph and are still returned by the MCP server, but with a `stale: true` flag on the response so clients can decide how much weight to give them.

---

## Bedrock KB Alignment

The Bedrock Knowledge Base currently ingests the markdown document corpus from S3. These semantic additions do not require changes to the Bedrock KB pipeline. The vector search for code now lives in Neo4j directly, via the `symbol_summary_embedding` and `community_summary_embedding` indexes.

One metadata sidecar convention to add: when the doc enrichment cron writes `Related Code` sections to markdown documents, it should include links to `CommunitySummary.name` strings where they exist. This creates textual cross-references between the document KB and the graph summary layer, improving recall when agents search docs for concepts that are better represented in the graph.

**Open question:** Should `SymbolSummary.purpose` + `SymbolSummary.details` also be piped into the Bedrock KB to allow the same semantic search to find both documentation and code? This would require writing synthetic markdown documents or using the Bedrock KB's metadata filtering to co-locate code and doc results. I lean toward keeping them separate (code summary search hits the Neo4j vector index; doc search hits Bedrock KB) and merging at the MCP server level. This is a retrieval strategy question, not a schema question, and I've flagged it as an open item in the migration document.
