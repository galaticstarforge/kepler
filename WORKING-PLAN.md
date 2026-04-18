# Kepler — Design Implementation Plan (Working Doc)

**Status:** Draft in progress. Not final. Refined incrementally.
**Branch:** `claude/design-implementation-plan-gaw0Q`
**Last updated:** 2026-04-17

This doc compares the documented design in `docs/` against the current code in
`packages/` and lays out a phased plan to implement the remaining work.
It is a **working document**; expect it to change as investigation continues.

---

## 1. Methodology

1. Read every design doc under `docs/` and distill acceptance criteria.
2. Inventory the code under `packages/` and map each design element to
   implemented / partial / missing.
3. Slice the remaining work into large phases that respect the migration
   ordering constraints documented in `docs/migration.md`.
4. Within each phase, call out concrete modules/files and acceptance tests.

---

## 2. Documented design — condensed acceptance criteria

### 2.1 Primitives (shared vocabulary)
- **Code primitives** (`docs/primitives/code.md`): Module, Symbol, Scope,
  Reference, CallSite, DataContainer, LiteralValue, Comment, DocAnnotation,
  Decorator, ErrorFlow, EventBinding with documented properties. Edges:
  CONTAINS, DEFINES, PARENT_SCOPE, RESOLVES_TO, CALLS, MEMBER_OF, EXTENDS,
  IMPLEMENTS, IMPORTS, EXPORTS, ANNOTATED_BY, HAS_TAG, DECORATED_BY,
  HANDLES_ERROR, THROWS, BINDS_EVENT, MUTATES.
- **Cloud primitives** (plugins only; core produces none): ComputeUnit,
  DataStore, DataAccessLayer, MessageChannel, EventSource, HTTPEndpoint,
  HTTPClient, Ingress, Proxy, NetworkRoute, DeploymentManifest,
  BuildPipeline, SyncTarget, Credential, IAMPermission. Edges as per doc.
- **Knowledge primitives**: Document, Concept nodes; DOCUMENTED_BY,
  REFERENCES, MENTIONS, RELATES_TO, SUPERSEDES edges.

### 2.2 Storage layer
- **Neo4j 5.11+** with GDS; pools sized 50/10/5 for MCP/orchestrator/
  enrichment. Cypher indexes: module_lookup, symbol_lookup, symbol_by_name,
  reference_location, callsite_location, scope_lookup, comment_type,
  document_path, document_type, document_service, community_repo,
  flag_name, external_service_name, symbol_summary_embedding,
  community_summary_embedding. Full-text indexes on symbol names/signatures,
  comments, literals.
- **DocumentStore** interface: get/put/delete/list/watch/head. Default: S3
  + EventBridge/SQS. Alternative: local filesystem + chokidar.
- **SemanticIndex** interface: upsert/delete/search/status. Default:
  Bedrock KB. Alternative: pgvector. Dev: sqlite-vec.
- **SourceAccess** interface: readFile/listFiles/diff/currentHead.
- All writes use UNWIND batch upserts; single-node writes forbidden in
  prod. Transaction per pass.

### 2.3 Documentation system
- Directory hierarchy under `docs-root/`: `_meta/`, `platform/`, `domains/`,
  `services/`, `apps/`, `operations/`, `.claude/`.
- Frontmatter YAML: title, type, status (current|draft|deprecated|proposed),
  author, created, updated, domain, service, app, tags, related, symbols,
  supersedes, confluence_sync.
- Document types: adr, runbook, guide, overview, reference, changelog,
  incident, postmortem, api, schema, pattern, glossary, service-map.
- `.claude/` subtree: `sessions/`, `proposals/` (indexed but filtered),
  `scratchpad/` (excluded). Templates ship with core; overrides in
  `_meta/templates/.overrides/`.

### 2.4 Doc-enrichment cron
- Runs every 30–60 min, independently.
- Resolves document references through (1) frontmatter `symbols:`,
  (2) inline code identifiers, (3) fenced imports, (4) `graph://` links.
  Precedence: exact (repo,file,name) → exact (repo,name) → fuzzy scoped →
  fuzzy repo.
- Emits REFERENCES/DOCUMENTED_BY/MENTIONS edges. Idempotent when corpus
  unchanged. Tracks `lastEnrichedHash` on Document.
- Optional: "Related Code" section update; LLM concept extraction.

### 2.5 MCP server
- SSE over HTTPS; stdio fallback. Bearer token with scopes (`docs:read`,
  `docs:write`, `graph:read`, `graph:write`, `admin:*`). Tokens cached 60 s.
- Rate limiting: per-token token-bucket returning `rate-limited` with
  retryAfter.
- **Tool surface (28 tools)**:
  - docs.* (9): create, read, update, delete, list, search, propose,
    listTemplates, applyTemplate
  - graph.* (13): query, findSymbol, symbolDetails, callers, callees,
    impactOf, relatedDocs, symbolsInDoc, moduleGraph, listServices,
    serviceTopology, semanticSearch, symbolContext, communityContext
  - admin.* (7): reindex, pluginStatus, passRunHistory, enrichmentRun,
    diagnostics, summarizationCoverage, triggerSummarization,
    recomputeMetrics
- `graph.query`: read-only, ≤10 s, ≤1 000 rows, parameterised only.
- Every response uses MCP content blocks and propagates traceId.

### 2.6 Enriched graph — three passes
- **Structural metrics** (no LLM): PageRank, Leiden community detection,
  RA-Brandes betweenness, fanIn/fanOut, BFS reachability.
  - Writes Community nodes + MEMBER_OF edges with `role`, `intra/inter`.
  - Symbol gets pageRank, betweenness, fanIn, fanOut,
    reachableFromEntry, depthFromEntry, communityId, communityRole.
  - Runs after full re-index, on ≥5 % edge change, or via
    `admin.recomputeMetrics`.
- **Behavioral extraction** (static): hasIO, hasMutation, isPure,
  effectKinds, configKeysRead, featureFlagsRead, docstring. New nodes:
  FlagDefinition, ExternalService. New edges: THROWS, CATCHES,
  READS_CONFIG, READS_FLAG, CALLS_SERVICE, TEST_ASSERTS.
- **Semantic enrichment**: SymbolSummary and CommunitySummary nodes with
  tier ∈ {provisional, canonical, partial}, contentHash, embedding
  (float[1536]), embeddingModel, plus git-mining properties, architectural
  layer, bounded context. Vector indexes (cosine, 1536-dim).

### 2.7 Summarization agent
- Deterministic priority queue (w1=0.4 pageRank, w2=0.3 fanIn, w3=0.2
  isPublicApi, w4=0.1 changeFrequency, w5=1.0 canonical penalty).
  Excludes summaries <30 days old.
- Cluster-at-a-time; resets at community boundary, 80 % token budget,
  layer crossing, 4-hop depth.
- Tool surface (narrow, 12 tools): get_community, get_node,
  get_existing_summary, expand_callers, expand_callees, read_file_range
  (≤500 lines), write_summary, mark_cluster_complete,
  list_pending_communities, get_coverage_report. No Cypher, no FS, no
  credentials.
- Validation loop: extract assertions (≤10), verify via Cypher, one
  retry, record `validationStatus` ∈ {validated, partial, unvalidated}.
- Two tiers (ADR-0002): provisional (one-sentence purpose + tags) vs
  canonical (full schema + assertions). Canonical threshold: pageRank
  ≥0.05, isPublicApi, or communityRole='bridge'.
- Model tiers: navigation=haiku, summary=sonnet, embedding=Titan
  1536-dim. Per-community token budgets. Cost ceiling `maxRunCostUSD`.
  Prometheus coverage gauges. S3-backed lock for parallelism.

### 2.8 CLI
- Commands (11): `init`, `discover`, `deploy`, `status`, `destroy`,
  `tunnel`, `ssh`, `plugin {upload,enable,disable,list,logs}`,
  `iam-policy`, `config {get,set}`, `version`, `upgrade`.
- Global flags: --json, --region, --profile, --verbose, --quiet,
  --no-color, --help, --version. Env equivalents.
- Error model: stable `KPL_E_XXXX` codes + remediation hints. Exit codes
  0/1/2/130.
- Local state `~/.config/kepler/state.yaml`; remote state in S3
  `kepler-state-<6-random>` with documented prefixes.
- Instance tiers (small/medium/large), VPC strategies (create/default/
  existing). Runtime image `ghcr.io/<org>/kepler-core:<cli-version>`.
- Connectivity: SSM only (no SSH keys, no public IPs).

### 2.9 Configuration
- Main `/etc/project/config.yaml` with sections: system, storage,
  sourceAccess, orchestrator, baseExtractor, enrichment, mcp,
  observability, plugins.
- Repo `/etc/project/repos.yaml` with defaults + repos (SSH only).

### 2.10 Deployment + observability + security
- Docker Compose: neo4j, orchestrator, mcp-server, enrichment-cron on
  EC2 (m7i.xlarge+). Volumes: neo4j-data, neo4j-logs, repo-clones (ro),
  config (ro).
- Logs: JSON stdout with timestamp, level, component, traceId. Metrics:
  Prometheus on :9090. Health: `/health`, `/ready`, `/metrics`. OTEL
  tracing.
- Security: token scopes, parameterised Cypher (rejects
  CREATE/MERGE/SET/DELETE/REMOVE), sandboxed markdown, secrets redaction,
  IAM role only.

### 2.11 Migration ordering (docs/migration.md)
1. Structural metrics
2. Behavioral extraction
3. Semantic enrichment schema (+ vector indexes)
4. First summarization run
5. MCP tool-surface update
6. Incremental update integration (nightly + optional CI)

---

## 3. Implementation inventory

### 3.1 CLI (`packages/cli`)

**Coverage vs `docs/cli/`:** 10/11 documented commands implemented.

| Command | Code | Gaps vs docs |
|---|---|---|
| `init` | Full | — |
| `discover` | Full | — |
| `deploy` | Partial | `--instance-type`, `--existing-vpc-id`, `--existing-subnet-id`, `--enable-bedrock-kb`, `--dry-run`; Bedrock KB opt-in not wired to CLI |
| `status` | Partial | `--all` (list all deployments) missing |
| `destroy` | Full | — |
| `tunnel` | Partial | `--remote-port`, `--detach`, `--cleanup` missing |
| `ssh` | Full | — |
| `plugin {upload,enable,disable,list,logs}` | Partial | `plugin logs --follow`, `--grep` missing |
| `config {get,set}` | Full (only `instanceTier` writable) | — |
| `iam-policy` | Full | — |
| `version` | Named `info` in code (cosmetic divergence) | — |
| `upgrade` | **Missing** | entire command absent |

**Library gaps:**
- `lib/errors.ts` defines error classes but **no `KPL_E_*` codes**; docs
  require stable codes + remediation hints.
- `lib/logger.ts`, `lib/prompts.ts`, `lib/state-bucket.ts`, `lib/config.ts`,
  `lib/prerequisites.ts`, `lib/validation.ts`,
  `lib/resolve-deployment.ts`, `lib/aws-clients.ts` — all functional.

### 3.2 Installer (`packages/installer`)

- `deployer.ts` exposes `deploy`, `diff`, `destroy`, `getStatus`.
- `KeplerStack` wires VPC, storage, IAM, EC2 instance, doc-event SQS
  pipeline, optional Bedrock KB.
- Instance-tier mapping matches docs (`small`, `medium`, `large`).
- `kepler-bedrock.ts`: OpenSearch Serverless collection **placeholder**
  (hardcoded empty ARN). Needs real provisioning or skip-path.
- No CloudFormation output for `CoreVersion` documented in
  `docs/cli/internals.md`.

### 3.3 Plugin SDK (`packages/plugin-sdk`)

- Exports `PluginMetadata`, `PluginContext`, `Plugin`, `definePlugin`.
- Hook surface matches design (`onFileRead`, `onGraphEnrich`). No plugin
  loader/registry exists in core yet — the contract exists in isolation.

### 3.4 Core runtime (`packages/core`)

**HTTP server (`server.ts`)**
- `GET /health` (version + uptime), `GET /ready`, `GET /metrics`
  (Prometheus text — only `kepler_core_uptime_seconds` exposed),
  `POST /mcp` (JSON in/out).
- **Gaps:** no SSE transport, no stdio transport, no bearer-token auth,
  no scope validation, no rate limiting, no traceId propagation.

**MCP router (`mcp/mcp-router.ts`)**
- Dispatches `tools/list` and `tools/call`. Tool registry in
  `mcp/handlers/index.ts`.
- **Implemented tools (14/31):**
  `docs.{create,read,update,delete,list,search,propose,listTemplates,applyTemplate}`,
  `graph.query`, `concepts.{list,read}`,
  `admin.{enrichmentRun,enrichmentStatus}`.
- **Missing tools (17/31):** all of `graph.{findSymbol, symbolDetails,
  callers, callees, impactOf, relatedDocs, symbolsInDoc, moduleGraph,
  listServices, serviceTopology, semanticSearch, symbolContext,
  communityContext}` and `admin.{reindex, pluginStatus, passRunHistory,
  diagnostics, summarizationCoverage, triggerSummarization,
  recomputeMetrics}`.

**Config (`config.ts`)**
- Sections implemented: system, storage (documents/semanticIndex/graph),
  sourceAccess, orchestrator, baseExtractor, enrichment, mcp,
  observability.
- **Gaps:** no `rateLimits` block, no `tracing` block, no full
  `observability.metrics.port`, no `plugins[]` array, no
  `orchestrator.passFailurePolicy`, no `passTimeoutSeconds`, no
  `enrichment.scheduleMinutes` / `relatedCodeSection` sections.

**Graph schema (`graph/schema.ts`)**
- `CORE_INDEX_STATEMENTS` (17 statements): module_lookup, symbol_lookup,
  symbol_by_name, reference_location, callsite_location, scope_lookup,
  comment_type, document_path, document_type, document_service,
  symbol_name_ft, comment_text_ft, literal_value_ft, concept_lookup,
  external_package_lookup, flag_name, external_service_name.
- **Gaps vs docs:** no `community_repo` index, no vector indexes
  (`symbol_summary_embedding`, `community_summary_embedding` — these are
  created on demand by `SemanticSummaryPass.ensureVectorIndexes`, but
  are not in the canonical startup list), no `bounded_context_lookup`
  index.

**Indexer — pipeline wiring (`indexer/orchestrator.ts`)**
- On each `RepoUpdateEvent` the orchestrator runs: file discovery → JS
  extract → write → behavioral analyze → write.
- **Gap:** orchestrator does **not** invoke any post-file analysis
  pass. The pass classes are scaffolded but never scheduled:
  - `SymbolContentHashPass` — exists, unused
  - `StructuralMetricsPass` (Leiden/PageRank/betweenness/GDS) — exists,
    unused
  - `GitVolatilityPass` — exists, unused
  - `BehavioralEdgesWriter` (transitive THROWS/TEST_ASSERTS) — exists,
    unused
  - `ArchitecturalLayerPass` — exists, unused
  - `BoundedContextPass` — exists, unused
  - `PublicApiPass` — exists, unused
  - `GovernsEdgesPass` — exists, unused
  - `SemanticSummaryPass` — persistence half exists; `run()`,
    `generateSymbolSummary()`, `generateCommunitySummary()` all throw
    `NotImplementedError`.
- No `passRunHistory` persistence; no DAG; no retry/timeout; no per-pass
  metric emission.

**Indexer — base extraction (`indexer/extractor/`)**
- `JsExtractor` emits Module, Symbol, ExternalPackage, CallSite,
  imports/exports.
- `BehavioralAnalyzer` derives `hasIO`, `hasMutation`, `isPure`,
  `effectKinds`, configKeysRead, featureFlagsRead, throwTypes,
  catches, serviceCalls, docstring (per-file regex).
- `GraphWriter.write()` upserts Module/Symbol/ExternalPackage/CallSite
  and `CONTAINS`/`IMPORTS`/`EXPORTS`. `writeBehavioral()` sets behavioral
  props, `THROWS`, `CATCHES`, `CALLS_SERVICE`, `READS_CONFIG`,
  `READS_FLAG`.
- **Gap vs primitives/code.md:** no `Reference` nodes, no `Scope` nodes,
  no `Comment` / `DocAnnotation` / `Decorator` / `LiteralValue` /
  `ErrorFlow` / `EventBinding` nodes. No `MEMBER_OF`/`EXTENDS`/
  `IMPLEMENTS`/`ANNOTATED_BY`/`HAS_TAG`/`DECORATED_BY`/`HANDLES_ERROR`/
  `BINDS_EVENT`/`MUTATES`/`RESOLVES_TO`/`PARENT_SCOPE` edges. No
  `CallSite.resolutionStatus` progression beyond what the extractor
  stamps.

**Repos / source access (`repos/`)**
- `GitRepoWatcher` clones/fetches and emits updates. `loadReposConfig`
  parses `repos.yaml`.
- **Gap vs storage.md "SourceAccess":** no `SourceAccess` interface
  (`readFile`, `listFiles`, `diff`, `currentHead`) — indexer reads
  directly via `fs.promises`.

**Document store (`storage/`)**
- `S3DocumentStore`, `FilesystemDocumentStore`, factory.
- **Gaps:** S3 store `watch()` via SQS only works when a queue URL is
  supplied — no EventBridge route wiring from installer (though the
  CDK construct exists). Filesystem watcher uses `fs.watch` (chokidar
  is on the wish list but not used).

**Semantic index (`semantic/`)**
- `BedrockSemanticIndex`, `NoopSemanticIndex`, factory.
- **Gaps:** no pgvector, no sqlite-vec; factory routes only bedrock/
  noop. `IndexStatus` returned but not surfaced on `/ready`.

**Docs (`docs/`)**
- Frontmatter parser; markdown stripper; template manager with 7
  default templates (adr, runbook, incident, postmortem, changelog-
  entry, service-readme, app-readme).
- **Gaps vs documentation-system.md:** directory hierarchy (`_meta/`,
  `platform/`, `domains/`, `services/`, `apps/`, `operations/`,
  `.claude/{sessions,proposals,scratchpad}`) is **not** materialised on
  startup (only templates are). No `.claude/proposals` filter in
  `docs.search` beyond what handler explicitly does. No
  `_meta/templates/.overrides/` override merge logic.

**Enrichment (`enrichment/`)**
- `ConceptExtractor` + `ConceptStore` + `EnrichmentRunner`. LLM
  factory (bedrock vs noop).
- **Gap vs doc-enrichment.md:** concept extraction works, but
  **document ↔ graph linking** (resolving `symbols:` / inline refs /
  fenced imports / `graph://` links → REFERENCES / DOCUMENTED_BY /
  MENTIONS edges) and "Related Code" section stamping is **not
  implemented**. No cron schedule (triggered only via MCP admin tool).

**LLM (`enrichment/llm/`)**
- `BedrockLlmClient` supports `complete` and `embed`. No separate
  model tiering (navigation/summary/embedding) — there is a single
  completion model.

**Plugin system (whole-core)**
- `packages/plugin-sdk` declares the contract; the core has **no
  plugin loader, no registry, no schema validation, no per-plugin
  config ingestion, no `fileReaders`, no pass enrichments.** The
  `config.plugins` array is also missing.

---

## 4. Gap matrix (high level)

| Area | Status |
|---|---|
| Bare HTTP + `/mcp` endpoint | ✅ |
| Neo4j driver + schema bootstrap | ✅ |
| Doc store (S3 + filesystem) | ✅ |
| Semantic index (bedrock + noop) | ✅ |
| Templates | ✅ |
| Base JS extraction + behavioral | ✅ |
| Git repo watcher | ✅ |
| Concept extraction | ✅ |
| Analysis-pass scaffolding | ✅ (not wired) |
| **Analysis passes scheduled / run** | ❌ |
| **Structural metrics (GDS)** | ❌ (class exists, not exercised) |
| **Semantic summaries** | ❌ (LLM path stubbed, persistence half) |
| **Summarization agent loop + tool surface** | ❌ |
| **MCP graph.\*** (13 tools) | ❌ |
| **MCP admin.\*** other than enrichment | ❌ |
| **MCP auth, scopes, rate limits, SSE** | ❌ |
| **Doc ↔ graph bidirectional linking cron** | ❌ |
| **Full documentation hierarchy + overrides** | ❌ |
| **Reference/Scope/Comment/Literal primitives** | ❌ |
| **CLI `upgrade`** | ❌ |
| **CLI `KPL_E_*` error codes** | ❌ |
| **CLI flag gaps** (`deploy`, `tunnel`, `plugin logs`) | ❌ |
| **Plugin loader + registry in core** | ❌ |
| **Full observability (Prometheus + OTel)** | ❌ |
| **SourceAccess abstraction** | ❌ |
| **pgvector / sqlite semantic index backends** | ❌ |
| **Runtime version pinning → CDK output** | ❌ |
| **Bedrock KB OpenSearch collection provisioning** | ❌ |

---

## 5. Phased plan

The phases below respect the ordering constraints in `docs/migration.md`
(structural → behavioral → semantic schema → first summarization run →
MCP surface update → incremental integration). Where independent work
streams exist (CLI polish, MCP tool expansion, observability) they are
called out as parallel tracks so they can proceed alongside the main
graph-enrichment spine.

The goal of each phase is that the system remains runnable at the end
of the phase, and every acceptance criterion in the phase is testable.

### Phase A — Pass runner and incremental spine

**Why first:** every later phase writes passes. A shared runner with
DAG ordering, timeout, retry, and `passRunHistory` persistence unblocks
structural metrics, behavioral edges, public-api, layer, context,
governs, and semantic-summary passes.

**Scope**
- Introduce `indexer/pass-runner.ts`: `PassRunner` with `register(pass,
  {dependsOn, timeoutSeconds})`, `runAll(repo)`, per-pass logging with
  traceId, per-pass `passRunHistory` row (start, end, status, stats,
  error).
- Pass contract: `{ name, runFor(repo, graph, config, logger) → Stats }`.
- Persist `passRunHistory` as Neo4j `PassRun` node under repo or as
  rows in doc store (pick doc store for simplicity of list/filter).
- Extend `OrchestratorConfig` with `passTimeoutSeconds`,
  `passFailurePolicy: 'continue'|'abort'`, `passes: {<name>: {enabled,
  config}}`.
- Hook `Orchestrator.indexRepo` to invoke `PassRunner.runAll(repo)`
  after per-file loop completes.

**Acceptance**
- Registering 2 passes with a dependency runs them in order.
- A pass timeout is surfaced as `status: 'timeout'` in the history row.
- Failure policy `continue` does not abort the pipeline.
- `admin.passRunHistory` MCP tool (added in Phase E) can list the last
  N runs per repo.

### Phase A2 — Schema version ratchet

**Why here:** §6b.2. Migration doc requires a one-way ratchet. Later
phases add indexes, node types, and edge labels; without a ratchet,
downgrades or mixed versions can silently corrupt the graph.

**Scope**
- Introduce `_KeplerMeta {id:'singleton', schemaVersion: int,
  updatedAt: datetime}` singleton node.
- `graph.applySchema` bumped to run numbered migrations from
  `packages/core/src/graph/migrations/<nnn>-*.ts`. Each migration
  exports `version`, `description`, `up(graph)`. Running older
  schema against newer code aborts startup with a typed error.
- CLI: `kepler upgrade` (Phase I) refuses to proceed if the live
  runtime's `schemaVersion` exceeds the CLI's bundled version
  (reverse-incompatibility check).
- Core-index statements become migration `001-core-indexes`.

**Acceptance**
- Starting core against a DB whose schemaVersion exceeds the
  runtime version exits with `KPL_E_SCHEMA_DOWNGRADE` (see Phase I
  error catalogue).
- Re-running the migrator is idempotent.

### Phase B — Structural metrics layer (GDS)

**Why next:** `docs/migration.md` explicitly orders structural first.
Communities and centrality are required inputs for summarization.

**Scope**
- Ensure GDS plugin is installed in the Neo4j docker image used by
  installer (`infra/docker-compose.yml` + `packages/core/Dockerfile`
  or installer user-data).
- Add `community_repo` b-tree index to `CORE_INDEX_STATEMENTS`.
- Wire `SymbolContentHashPass` first (others depend on `Symbol.hash`
  for staleness).
- Wire `StructuralMetricsPass` into the pass runner. Projections:
  `calls-graph` from `CALLS` edges. Algorithms: PageRank
  (maxIterations 20, damping 0.85), RA-Brandes betweenness
  (samplingSize 5000), Leiden (gamma 1.0 default). BFS reachability
  from entry symbols (`Module.isEntryPoint=true` — need to set this
  on entry-point modules during discovery or heuristically detect).
- Write-backs: `Symbol.{pageRank, betweenness, fanIn, fanOut,
  reachableFromEntry, depthFromEntry, communityId, communityRole}`;
  `Community {communityId, repo, size, cohesion, coreCount,
  boundaryCount, label}`; `MEMBER_OF {role, intraCommunityEdges,
  interCommunityEdges}`.
- Triggers: first run after initial index; subsequent runs on ≥5 %
  edge-count delta vs last run, or via `admin.recomputeMetrics` MCP
  tool (Phase E).

**Acceptance**
- Re-indexing a trivial repo produces ≥1 `Community` node with
  `role`-classified members.
- GDS heap failure surfaces as a typed error and does not crash the
  orchestrator.
- `Symbol.depthFromEntry` is populated for symbols reachable from
  entry points.

### Phase C — Behavioral enrichment completion

**Why next:** migration step 2. Behavioral edges complete the graph
before summarization reads from it.

**Scope**
- Wire `BehavioralEdgesWriter` into the pass runner. Make `THROWS`
  edges transitive up to depth 5. Emit `TEST_ASSERTS` with coverage
  kind inferred from path conventions (`/test/` vs `/__tests__/`,
  `.test.`/`.spec.` suffixes, `e2e/` prefix, etc.).
- Wire `GitVolatilityPass` into the pass runner (runs after base
  extraction). Produces `Symbol.{changeFrequency, authorCount,
  lastModified, gitAge}` with a 30-day window over a 90-day history.
- Wire `ArchitecturalLayerPass`, `BoundedContextPass`, `PublicApiPass`
  into the runner. `BoundedContext` declarations read from
  `repos.yaml` (needs extension — add `boundedContexts: [{id, paths}]`
  per repo).
- Wire `GovernsEdgesPass`: reads `symbols:` and `governs:` frontmatter
  from the doc store, emits `GOVERNS` edges.
- Close primitive gaps identified in inventory: at minimum emit
  `Reference` nodes for identifier uses, `Scope` nodes with
  `PARENT_SCOPE`, `Comment` nodes for block/line comments (used by
  docstring extraction later). Defer `Decorator`, `EventBinding`,
  `LiteralValue`, `DataContainer` to a follow-up track unless needed
  for summarization validation.

**Acceptance**
- A repo with a documented throw chain produces a transitive `THROWS`
  path from call-site to handler.
- Test files produce `TEST_ASSERTS` edges with `coverageKind` ∈
  `{unit, integration, e2e}`.
- `Symbol.isPublicApi` is `true` only for exported, non-barrel,
  non-underscore, non-`@internal` symbols.
- At least one `GOVERNS` edge can be emitted by a doc with
  `symbols:` frontmatter.

### Phase D — Semantic enrichment schema + vector storage

**Why next:** migration step 3. The summarization pass (Phase F) and
`graph.semanticSearch` MCP tool (Phase E) need the schema and vector
indexes in place first. No LLM work here.

**Scope**
- Extend `CORE_INDEX_STATEMENTS` with `symbol_summary_embedding` and
  `community_summary_embedding` vector indexes (1536-dim, cosine).
  Fail fast if Neo4j is <5.11.
- Readiness check: `/ready` asserts both vector indexes are `ONLINE`
  (adds a `db.indexes()` query). Until then, `graph.semanticSearch`
  returns 503.
- Add `embeddingModel` property to summary nodes; on model change,
  drop & recreate the index (one-way ratchet). Store the current
  model name in `_meta/embedding-model.yaml` in the doc store for
  cross-boot comparison.
- Add missing summary properties per `docs/graph/semantic-
  enrichment.md`: `Symbol.{changeFrequency, authorCount, lastModified,
  gitAge, isPublicApi, architecturalLayer, boundedContextId}` —
  already covered by Phase C passes, but confirm writers produce them.
- Add `BoundedContext`, `ArchitecturalLayer` node indexes
  (`bounded_context_lookup`, `architectural_layer_lookup`).
- Add config validation: fail startup if `summarization.embedding.
  dimensions` disagrees with deployed index.

**Acceptance**
- Fresh deploy on Neo4j 5.11+ creates both vector indexes and
  `/ready` becomes 200 after indexes are ONLINE.
- Changing the embedding model in config and restarting causes the
  vector indexes to be dropped and recreated exactly once, with a
  single log line announcing the change.

### Phase E — MCP surface expansion + auth + rate limits

**Why here:** graph tools need the enriched schema from Phases B–D to
return meaningful results, but this phase can start in parallel with
Phase C once the schema nodes exist.

**Scope**
- Add SSE transport alongside POST. Keep JSON POST for local dev.
- Add bearer-token auth layer. Tokens loaded from config or AWS
  Secrets Manager. Scopes: `docs:read`, `docs:write`, `graph:read`,
  `graph:write`, `admin:*`. Cache tokens 60 s.
- Add per-token token-bucket rate limiter. Return MCP `rate-limited`
  error with `retryAfter`.
- Harden `graph.query`: reject `CREATE|MERGE|SET|DELETE|REMOVE|DROP|
  CALL db.*` via parser-level check. Enforce 10 s timeout and 1 000-
  row cap.
- Implement the missing `graph.*` tools as Cypher-backed handlers:
  `findSymbol`, `symbolDetails`, `callers`, `callees`, `impactOf`
  (transitive CALLS+THROWS depth-bounded), `relatedDocs` (uses
  `DOCUMENTED_BY`/`GOVERNS`), `symbolsInDoc`, `moduleGraph`,
  `listServices`, `serviceTopology`, `semanticSearch` (vector index
  query), `symbolContext`, `communityContext`.
- Implement `admin.{reindex, pluginStatus, passRunHistory,
  diagnostics, recomputeMetrics}`. `triggerSummarization` +
  `summarizationCoverage` land in Phase F alongside the agent.
- Propagate a `traceId` per request into logs and downstream graph
  queries.

**Acceptance**
- Curl without bearer token → 401 with MCP error.
- Token with `docs:read` scope cannot call `docs.create`.
- Heavy caller hits `rate-limited` with a non-zero `retryAfter`.
- `graph.query` rejects a mutation query with a structured error.
- All 13 documented `graph.*` tools + 5 documented `admin.*` tools
  return valid MCP content blocks on a populated graph.

### Phase F — Agentic summarization subsystem

**Why here:** requires every prior phase. Needs communities, public-api
flags, git volatility, vector indexes, and the MCP surface as its
consumer.

**Scope split into F1 (toolchain) → F2 (agent loop) → F3 (scheduling).**

#### F1 — Tool surface
- New package boundary: `packages/core/src/summarization/`.
- Implement the 10 narrow tools (`docs/summarization/tool-surface.md`):
  `get_community`, `get_node`, `get_existing_summary`,
  `expand_callers`, `expand_callees`, `read_file_range` (≤500 lines,
  reads via `SourceAccess` — introduce that abstraction here if not
  earlier), `write_summary`, `mark_cluster_complete`,
  `list_pending_communities`, `get_coverage_report`.
- Tool invocations are logged with a `runId` + per-call trace row to
  a doc-store `summarization/_runs/<runId>.jsonl` file.

#### F2 — Agent loop
- Priority queue (w1..w5 per ADR-0002 / cost doc). Excludes
  summaries <30 days old.
- Cluster-at-a-time processing with reset on community boundary /
  80 % token budget / layer crossing / 4-hop depth.
- Two-tier output (ADR-0002): provisional (haiku, purpose+tags) for
  non-focal; canonical (sonnet, full schema + assertions) for
  pageRank ≥0.05, isPublicApi, or communityRole=bridge.
- Validation loop (ADR-0003): ≤10 assertions, Cypher verify
  `calls`/`throws`/`reads_config`, one retry, record
  `validationStatus ∈ {validated, partial, unvalidated}`.
- Embedding write alongside summary write; honour `maxRunCostUSD`
  ceiling before continuing to the next community.
- Parallelism: S3-backed lock `summarization/_locks/<communityId>`
  to prevent overlapping runs on boundary-sharing communities.

#### F3 — Scheduling + MCP exposure
- Nightly run scheduled via cron or an in-process timer driven by
  config (`summarization.schedule: cron`).
- MCP `admin.triggerSummarization` (modes: `full`, `incremental`,
  `priority-only`), `admin.summarizationCoverage` (exposes
  canonical %, provisional %, stale %, unsummarized %, estimated
  cost), both from Phase E stubs.
- Prometheus gauges: `kepler_summarization_canonical_pct`,
  `kepler_summarization_stale_count`,
  `kepler_summarization_last_run_cost_usd`.

**Acceptance**
- A clean run over a small repo produces canonical summaries for
  top-10 pageRank symbols and provisional for the rest, with
  `validationStatus` set.
- Cost ceiling is enforced: a configured `$0.10` ceiling on a repo
  costing >$0.10 stops mid-run and emits a typed warning.
- `graph.semanticSearch` returns summary hits ranked by cosine.

### Phase G — Doc ↔ graph enrichment cron

**Why here:** depends on the enriched graph. Independent of the
summarization agent — can proceed in parallel with F.

**Scope**
- New cron owner `enrichment/doc-graph-reconciler.ts` (separate from
  the concept extractor, which stays).
- Reference resolvers in order: frontmatter `symbols:`, inline code
  identifiers, fenced imports, `graph://` links.
- Precedence: exact (repo,file,name) → exact (repo,name) → fuzzy
  domain-scoped → fuzzy repo-wide.
- Edge writes: `REFERENCES`, `DOCUMENTED_BY`, `MENTIONS`. Per-doc
  `lastEnrichedHash` property on `Document`. Idempotent when corpus
  unchanged.
- Optional "Related Code" section updater with delimited markers
  (`<!-- kepler:related-code:start -->` / `end`) and unit tests.
- Config: `enrichment.docGraphCron.scheduleMinutes` (30–60 min).
- Materialise the full doc hierarchy (`_meta`, `platform`, `domains`,
  `services`, `apps`, `operations`, `.claude/{sessions,proposals,
  scratchpad}`) on first run by creating `.keep` placeholders and
  moving templates into `_meta/templates/`. Implement override merge
  from `_meta/templates/.overrides/`.

**Acceptance**
- A doc with `symbols: [{repo, path, name}]` produces a
  `DOCUMENTED_BY` edge in one cycle; running again does nothing
  (idempotent).
- Unresolved references appear in the cron's run summary and in
  `admin.diagnostics`.
- `.claude/scratchpad/` paths are excluded from `docs.search`.

### Phase H — Observability, security hardening, secrets

**Why here:** independent of graph/summarization work, can run as a
parallel track starting after Phase A.

**Scope**
- Metrics (Prometheus, `/metrics` on a dedicated port from
  `observability.metrics.port`): histograms for
  `index_pass_duration_seconds`, `graph_query_duration_seconds`,
  `mcp_request_duration_seconds`; counters for
  `index_pass_errors_total`, `mcp_rate_limit_hits_total`,
  `docs_store_operations_total`, `semantic_index_operations_total`;
  gauges for `repo_index_last_success_timestamp`,
  `repo_index_last_failure_timestamp`.
- OpenTelemetry tracer: OTLP exporter, sampling rate from config,
  root span per MCP request, child spans per Cypher query and per
  pass.
- Log redaction layer for tokens, passwords, AWS keys.
- Markdown rendering sandbox: spawn worker thread or isolated
  subprocess with no fs/net capability; applies to
  `docs.applyTemplate` and any future render paths.
- Secrets manager integration: MCP tokens + Neo4j password loaded
  from AWS Secrets Manager when `KEPLER_SECRETS_SOURCE=secretsmgr`.
- Docker compose: add `neo4j-admin-password` docker secret; read at
  startup.

**Acceptance**
- `/metrics` exposes ≥12 Kepler metrics with stable label sets.
- OTel traces flow end-to-end for an MCP request that touches graph
  + semantic index.
- Log lines never surface a bearer token, AWS secret, or Neo4j
  password even when error-wrapped.

### Phase I — CLI completion

**Why here:** parallel track. Stand-alone; only Phase E touches the
server half of plugin upload/restart.

**Scope**
- Implement `kepler upgrade`: compares local CLI version against npm
  latest and the deployed runtime image tag.
- Introduce stable `KPL_E_XXXX` error codes (catalogue in
  `packages/shared/src/errors.ts`) with hints; use them throughout
  `packages/cli/src/lib/errors.ts`.
- Missing flags: `deploy --instance-type`, `--existing-vpc-id`,
  `--existing-subnet-id`, `--enable-bedrock-kb`, `--dry-run`;
  `status --all`; `tunnel --remote-port`, `--detach`, `--cleanup`;
  `plugin logs --follow`, `--grep`.
- Address `docs/cli-completion-plan.md` issues: drop
  `removeComments: true` from installer tsup, kill `not-implemented.
  ts`, remove dead files, replace hardcoded `'0.0.1'` in `deploy.ts`
  with the real version, scope Bedrock IAM to region, split ECR
  `GetAuthorizationToken`.
- Rename `info` command back to `version` (alias the old name for
  one release).
- Add `CoreVersion` CloudFormation output so CLI can compare deployed
  runtime version.
- OpenSearch Serverless collection provisioned by
  `kepler-bedrock.ts` (remove placeholder empty ARN).

**Acceptance**
- `kepler upgrade` prints current vs latest CLI and deployed
  runtime.
- Every documented error in `docs/cli/commands.md` maps to a
  `KPL_E_*` code printed alongside the hint.

### Phase K — Runtime deployment bootstrap (emergency)

**Why:** §6b.1 above. A fresh `kepler deploy` currently produces a
container that exits on startup. This should be prioritised alongside
Phase A (or ahead of it) because every other phase assumes a running
runtime.

**Scope**
- Extend `kepler-instance.ts` user-data compose file to include a
  `neo4j` service sharing a `kepler-net` network with `core`.
  Pin to `neo4j:5.x-community` with GDS plugin (env
  `NEO4J_PLUGINS='["graph-data-science"]'`). Persist `neo4j-data`,
  `neo4j-logs` to an EBS-backed volume.
- Neo4j admin password: generated on deploy, stored in Secrets
  Manager, mounted into the compose env as a Docker secret.
- Config/repos sync mechanism:
  - `deployments/<name>/runtime/config.yaml` and
    `deployments/<name>/runtime/repos.yaml` live in the state bucket.
  - A `kepler-config-sync` sidecar (or systemd timer) pulls both
    into `/etc/project/` before `core` starts. Alternatively,
    bake an init-container that uses `aws s3 cp`.
- SSH deploy-key material mounted read-only (path from config) via
  Secrets Manager + SSM parameter store.
- GHCR image reference: parameterise the org
  (`${github.repository_owner}` in user-data too) rather than
  hardcoding `vleader`.
- Add `CoreVersion` CloudFormation output so `kepler upgrade` and
  `kepler status` can compare CLI vs deployed runtime.
- Add a smoke test in `packages/installer/test/` that asserts the
  compose file includes `neo4j` and sets `KEPLER_CONFIG_PATH`.

**Acceptance**
- `kepler deploy` produces an instance where
  `docker compose ps` shows both `core` and `neo4j` running.
- Core `/ready` returns 200 within 2 minutes of instance first boot.
- `kepler status` shows `CoreVersion` matching the CLI minor
  version.

### Phase J — Plugin loader + SourceAccess + remaining primitives

**Why last:** "Zero plugins, still useful" principle means core is
valuable without plugins. Still, the plugin contract is load-bearing
for cloud primitives, and `SourceAccess` (if not introduced in F1)
is needed for deterministic source reads.

**Scope**
- `SourceAccess` abstraction (storage.md): `readFile`, `listFiles`,
  `diff`, `currentHead`. Implement `GitSourceAccess` over the
  existing clone directory. Cache per run. Swap `fs.promises` reads
  inside the indexer.
- Plugin loader: scan enabled plugins from `plugins/enabled.yaml`
  (already uploaded by `kepler plugin upload`), load via dynamic
  `import()`, register `fileReaders` + graph-enrichment passes with
  the pass runner + schema registry. Validate declared node/edge
  types against existing schema to enforce "no conflicts" rule.
- Plugin config nesting under `config.plugins[]` with JSON Schema
  validation.
- Remaining code primitives (if not done in Phase C): `Decorator`,
  `LiteralValue`, `DataContainer`, `EventBinding`, `DocAnnotation`,
  `ErrorFlow`, plus corresponding edges. Prioritise what consumers
  (summarization assertions, doc enrichment resolvers) actually
  read.
- `pluginStatus` MCP handler finally returns real data.

**Acceptance**
- A trivial example plugin that adds a fileReader for a new
  extension is loaded, registers a pass, and writes to the graph
  without touching core.
- Schema-conflict plugin (declares an existing node type with a
  conflicting property) is rejected at registration time.

---

## 6. Parallelisation guide

| Track | Depends on | Runs in parallel with |
|---|---|---|
| **K (runtime bootstrap)** | — | everything (**prioritise**) |
| A (pass runner) | K | I, H |
| A2 (schema ratchet) | A | B–J |
| B (structural metrics) | A, A2 | H, I |
| C (behavioral completion) | A, A2 (schema only) | H, I |
| D (semantic schema + vectors) | B, C, A2 | E (tool stubs), H, I |
| E (MCP expansion + auth) | D for semanticSearch; C for graph.* | H, I |
| F (summarization agent) | A–E | G, H, I |
| G (doc↔graph cron) | C (for symbol index) | F, H, I |
| H (observability, security) | A | B–G, I |
| I (CLI completion) | K (for CoreVersion output) | B–H |
| J (plugins + SourceAccess + remaining primitives) | A, C | — |

The critical path is **K → A → A2 → B → C → D → F.** Everything else
can move alongside.

Phase K first: every other phase assumes a functioning runtime on a
fresh deploy. Without K, none of B–J can be validated end-to-end.

---

## 6b. Additional gaps surfaced in review

These turned up during a second pass and were not captured in the
inventory above.

### 6b.1 Runtime deployment is non-functional today

`packages/installer/src/stacks/constructs/kepler-instance.ts` builds
user-data that runs **only** the `core` container. Concretely:

- No Neo4j sidecar. `index.ts` calls `graph.connect()` and
  `process.exit(1)` on failure — a fresh deploy crashes immediately.
- No config file delivery. Core reads
  `/etc/project/config.yaml` (or `$KEPLER_CONFIG_PATH`), but
  user-data never writes one. The container falls back to
  `DEFAULT_CONFIG` (filesystem doc store, bolt to `localhost:7687`,
  no KB).
- No `repos.yaml` delivery. Indexer cannot activate.
- No SSH deploy-key material mounted; `sourceAccess.sshKeyPath` has
  nothing to point at.
- GHCR image org is hardcoded to `vleader` in user-data but the
  release workflow publishes under `${github.repository_owner}` —
  they will disagree in any fork.

### 6b.2 Schema migration / version ratchet

`docs/cli/versioning.md` mandates a one-way schema ratchet, but
nothing in code implements a `schemaVersion` property on a
`_KeplerMeta` node, nor a migrator. `graph.applySchema` only runs
idempotent `CREATE INDEX IF NOT EXISTS` statements.

### 6b.3 Monorepo release path exists

`.github/workflows/release.yml` + `.changeset/` show a working
changesets-based release flow to npm + a GHCR image build keyed on
`packages/core/package.json`.`version`. This is important input for
Phase I (CLI `upgrade`) because the CLI needs a stable way to
resolve "latest". The pipeline is already there; the CLI just
needs to read from npm.

### 6b.4 CI baseline already exists

`.github/workflows/ci.yml` runs `pnpm lint/build/typecheck/test`
on Node 20 and 22 plus Docker build + CDK synth validation. Every
phase below should add tests under `packages/{core,cli,installer}/
test/` to that matrix (the harness is Vitest; existing tests
under `packages/core/test/indexer/` are good patterns to copy).

### 6b.5 "info" vs "version" is already leaking into docs

`docs/getting-started.md` uses `kepler info` whereas
`docs/cli/commands.md` uses `kepler version`. The command in code
is `info`. Decide one canonical name before Phase I renames things.

### 6b.6 Local dev Neo4j

`infra/docker-compose.yml` runs only Neo4j with `NEO4J_AUTH: none`
and no GDS plugin. Phase B's GDS requirement means this file also
needs to gain the GDS plugin (env var `NEO4J_PLUGINS='["graph-data-
science"]'` or a custom image). Flag this alongside Phase B.

---

## 7. Open questions / risks

- **GDS plugin packaging.** `infra/docker-compose.yml` needs the GDS
  plugin shipped with the Neo4j image. Confirm licensing for OSS GDS
  on Community Edition — may require pinning to a specific GDS
  version.
- **OpenSearch Serverless provisioning.** `kepler-bedrock.ts`
  currently hardcodes an empty collection ARN. Real provisioning
  needs an access policy, a data policy, and a security policy —
  meaningful extra CDK work. Flag for early spike.
- **Summarization cost accounting.** `maxRunCostUSD` requires
  pre-estimating tokens. Consider a first-pass dry-run mode that
  counts symbols but does not call the LLM.
- **Reference-node volume.** Emitting every identifier use as a
  `Reference` node may explode graph size. May want to default-off
  and gate behind config.
- **Bedrock embeddings vs KB embeddings.** `BedrockLlmClient` doc
  already warns that these are different vector spaces. The doc-
  concept-dedup pipeline uses the client directly, not the KB — do
  **not** conflate this with summary embeddings (which are stored on
  the graph per ADR-0004).
- **Pass-run history storage.** Neo4j vs doc store is an open call.
  Doc store is simpler for listing/truncation; graph is cleaner for
  correlation with nodes. Leaning doc store.

---

## 8. Next actions

1. **Ship Phase K first.** Runtime is broken on a fresh deploy —
   Neo4j sidecar, config/repos sync, GHCR org parameterisation.
   Everything else is untestable end-to-end until this is fixed.
2. In parallel, ship Phase A (pass runner + `passRunHistory`) as a
   small PR — this unblocks all graph-enrichment phases.
3. Open spike tickets for: GDS plugin packaging in the Neo4j image,
   OpenSearch Serverless collection provisioning for Bedrock KB,
   runtime-to-state-bucket config sync mechanism (init container vs
   systemd timer).
4. Start Phase I in parallel — CLI flag gaps and `KPL_E_*` codes
   are independent of the runtime.
5. Once Phase A is in, Phase A2 (schema ratchet) is a very small
   follow-up and should go before any migration-worthy schema
   change lands in B/C/D.
