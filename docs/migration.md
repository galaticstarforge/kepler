# Migration Guide: Enriched Graph Layer and Agentic Summarization

This guide covers the steps required to migrate an existing Kepler installation to the enriched graph architecture. I describe each phase as a discrete unit that can be deployed and verified independently. No phase depends on the phase after it; each adds capability on top of what came before.

---

## Prerequisites

### Neo4j Version

Native vector indexes require **Neo4j 5.11 or later**. Check your current version:

```cypher
CALL dbms.components() YIELD versions RETURN versions[0]
```

If you are on an earlier release, upgrade Neo4j before proceeding. The structural metrics and behavioral extraction passes do not require vector index support and can run on older versions, but the semantic enrichment layer does. I recommend going to 5.11+ up front to avoid a second upgrade mid-migration.

### Neo4j GDS Plugin

The structural metrics pass uses the Graph Data Science library. Install it by adding the plugin to your Docker Compose configuration:

```yaml
# docker-compose.yml
services:
  neo4j:
    image: neo4j:5.11-community
    environment:
      NEO4J_PLUGINS: '["graph-data-science"]'
      NEO4J_dbms_memory_heap_initial__size: 2g
      NEO4J_dbms_memory_heap_max__size: 4g
      NEO4J_dbms_memory_pagecache_size: 2g
```

GDS Community Edition is included in the plugin bundle and covers all algorithms used here: PageRank, RA-Brandes betweenness, Leiden community detection, degree, and BFS.

After adding the plugin, verify installation:

```cypher
RETURN gds.version()
```

### Memory Sizing

The GDS algorithms run in-memory projections. For a codebase of 50,000+ symbols, the GDS graph projection can consume 2-4 GB of off-heap memory. I recommend:

| Codebase Size | Neo4j Heap | Page Cache | GDS Off-Heap |
|---|---|---|---|
| < 10,000 symbols | 2 GB | 2 GB | 1 GB |
| 10,000-50,000 | 4 GB | 4 GB | 2 GB |
| > 50,000 | 8 GB | 6 GB | 4 GB |

"GDS Off-Heap" is managed automatically by GDS; set `gds.heap.max_size` in `neo4j.conf` to reserve it. If you skip this setting, GDS will borrow from the heap, which causes GC pressure during large algorithm runs.

---

## Phase 1: Structural Metrics

**What this phase adds:**

- Pre-computed `pageRank`, `betweenness`, `fanIn`, `fanOut` on `Symbol` nodes.
- Community detection via Leiden. New `Community` nodes. `MEMBER_OF` edges. `communityId` and `communityRole` on `Symbol`.
- `reachableFromEntryPoint` and `depthFromEntry` via BFS from entry-point modules.

**Schema changes:** additive only. New properties on existing nodes, new `Community` node type, new `MEMBER_OF` edge type. No existing properties are removed or renamed.

**Migration steps:**

1. Install GDS plugin and restart Neo4j (see prerequisites above).
2. Run the `structural-metrics` cron pass via `admin.passRunHistory` to confirm GDS is available.
3. Trigger the pass: `admin.reindex` with `pass: 'structural-metrics'`.
4. Monitor: the pass logs GDS algorithm start/end times and result counts. A full pass over 50,000 symbols runs in approximately 5-15 minutes depending on graph density.

**Verification:**

```cypher
MATCH (s:Symbol) WHERE s.pageRank IS NOT NULL RETURN count(s) AS enriched
MATCH (c:Community) RETURN count(c) AS communities
```

Both queries should return non-zero values. If `enriched = 0` after the pass, check the cron logs for GDS projection errors.

**Rollback:** The structural metrics properties are additive. To roll back, run:

```cypher
MATCH (s:Symbol) REMOVE s.pageRank, s.betweenness, s.fanIn, s.fanOut,
  s.reachableFromEntryPoint, s.depthFromEntry, s.communityId, s.communityRole
MATCH (c:Community) DETACH DELETE c
```

---

## Phase 2: Behavioral Extraction

**What this phase adds:**

- `hasIO`, `hasMutation`, `isPure`, `effectKinds`, `configKeysRead`, `featureFlagsRead` on `Symbol` nodes.
- `docstring` property populated from JSDoc, TSDoc, or language-equivalent.
- New edge types: `THROWS`, `CATCHES`, `READS_CONFIG`, `READS_FLAG`, `CALLS_SERVICE`.
- New node types: `FlagDefinition`, `ExternalService`.

**Dependencies:** Phase 1 is not required for Phase 2. Behavioral extraction is pure static analysis and does not use GDS. However, running Phase 1 first is recommended because `communityId` is useful context when reviewing behavioral analysis results.

**Migration steps:**

1. Deploy the behavioral extraction plugin to the indexer.
2. For TypeScript/JavaScript codebases: no additional tooling required. For .NET: the Roslyn analyzer plugin must be installed. For Python: the `ast` extractor is included.
3. Trigger: `admin.reindex` with `pass: 'behavioral'`.
4. Monitor: the pass logs per-file extraction results. The first run processes all files. Subsequent runs are incremental.

**Note on pattern library:** external service detection relies on a pattern library mapping import paths to service names (e.g., `stripe` or `@aws-sdk/client-s3` maps to an `ExternalService` node named `S3`). The default library covers common libraries. Custom patterns can be added in `config.yaml`:

```yaml
behavioralExtraction:
  externalServicePatterns:
    - importPattern: '@acme/payments-client'
      serviceName: 'acme-payments'
      protocol: 'http'
```

**Verification:**

```cypher
MATCH (s:Symbol) WHERE s.hasIO IS NOT NULL RETURN count(s) AS withBehavioralProps
MATCH ()-[r:THROWS]->() RETURN count(r) AS throwsEdges
MATCH (es:ExternalService) RETURN es.name
```

**Rollback:** Behavioral properties are additive. Remove with:

```cypher
MATCH (s:Symbol) REMOVE s.hasIO, s.hasMutation, s.isPure, s.effectKinds,
  s.configKeysRead, s.featureFlagsRead, s.docstring
MATCH (fd:FlagDefinition) DETACH DELETE fd
MATCH (es:ExternalService) DETACH DELETE es
```

---

## Phase 3: Semantic Enrichment Schema

**What this phase adds:**

- New node types: `SymbolSummary`, `CommunitySummary`, `BoundedContext`, `ArchitecturalLayer`.
- New edge types: `HAS_SUMMARY`, `HAS_COMMUNITY_SUMMARY`, `SUMMARIZED_IN_CONTEXT_OF`, `TEST_ASSERTS`, `IN_LAYER`, `IN_CONTEXT`, `GOVERNS`.
- New properties on `Symbol`: `isPublicApi`, `architecturalLayer`, `boundedContextId`, `changeFrequency`, `authorCount`, `lastModified`, `gitAge`.
- Native vector indexes: `symbol_summary_embedding`, `community_summary_embedding`.

**Dependencies:** Phase 1 must be complete. `SymbolSummary` nodes reference `communityId` from Phase 1. Phase 2 is recommended (provides `docstring` and behavioral properties to the summarization agent) but not strictly required.

**Neo4j version requirement:** 5.11+ required for vector indexes.

**Migration steps:**

1. Confirm Neo4j version is 5.11+.
2. Apply the schema migration: `admin.runMigration` with `migration: 'semantic-enrichment-schema'`. This migration creates the vector indexes and any required constraints.
3. Verify index creation: `SHOW INDEXES WHERE type = 'VECTOR'` should return the two new indexes in `ONLINE` state. The index build is asynchronous. For a graph with existing `SymbolSummary` nodes, the build may take several minutes.
4. Configure git mining (optional but strongly recommended):
   ```yaml
   gitMining:
     enabled: true
     repoBasePath: /repos
     rollingWindowDays: 90
   ```
5. Trigger the git mining pass: `admin.reindex` with `pass: 'git-mining'`. This populates `changeFrequency`, `authorCount`, `lastModified`, and `gitAge` on `Symbol` nodes.

**Verification:**

```cypher
SHOW INDEXES WHERE type = 'VECTOR' RETURN name, state
MATCH (s:Symbol) WHERE s.changeFrequency IS NOT NULL RETURN count(s) AS withGitProps
```

---

## Phase 4: First Summarization Run

**What this phase adds:**

- `SymbolSummary` nodes for all eligible symbols.
- `CommunitySummary` nodes for all communities.
- Embeddings on all summary nodes.

**Dependencies:** Phases 1 and 3 must be complete.

**Before running:**

1. Check the cost estimate: call `admin.summarizationCoverage`. Review the `estimatedCostUSD` field for the full run.
2. Set a cost ceiling in config if needed: `summarization.maxRunCostUSD`.
3. Confirm the embedding model matches the vector index dimension (1536-dim for the default model).

**Running the full pass:**

```bash
kepler summarize --repo <repo> --full
```

Or trigger via admin tool: `admin.triggerSummarization` with `mode: 'full'`. The coordinator starts parallel agents (default: up to 4) and processes communities in priority order.

**Monitoring:**

- Progress is written to `admin.summarizationCoverage` in real time.
- Prometheus metrics: `kepler_summarization_canonical_pct`, `kepler_summarization_stale_count`.
- Coordinator logs include per-community timing and cost.

A full first pass over a medium-sized codebase (20,000 symbols, 200 communities) takes 2-4 hours at 4 agents with `claude-3-5-haiku` for provisionals and `claude-3-5-sonnet` for canonicals.

**Verification:**

```cypher
MATCH (ss:SymbolSummary) RETURN count(ss) AS summaries, 
  count(ss.embedding) AS withEmbeddings,
  sum(CASE WHEN ss.tier = 'canonical' THEN 1 ELSE 0 END) AS canonical,
  sum(CASE WHEN ss.tier = 'provisional' THEN 1 ELSE 0 END) AS provisional
```

---

## Phase 5: MCP Tool Surface Update

The enriched graph and summarization layers expose new MCP tools. These are available immediately after deploying the updated server binary; they do not require a reindex.

New tools available after deployment: `graph.semanticSearch`, `graph.symbolContext`, `graph.communityContext`, `admin.summarizationCoverage`, `admin.triggerSummarization`, `admin.recomputeMetrics`.

Clients that were granted `graph:read` scope will automatically have access to `graph.semanticSearch`, `graph.symbolContext`, and `graph.communityContext`. The three new `admin.*` tools require `admin:*` scope.

---

## Phase 6: Incremental Update Integration

After the initial full pass, configure Kepler to run incremental summarization passes automatically.

**Recommended configuration:**

```yaml
summarization:
  schedule: '0 2 * * *'      # 2 AM nightly
  incremental: true
  maxRunCostUSD: 20.00
  structuralMetricsSchedule: '0 1 * * 0'   # GDS re-run weekly on Sundays
```

The structural metrics pass (GDS algorithms) should be re-run periodically as the codebase grows. Weekly is appropriate for most teams. After each GDS run, communities may shift; the summarization pass detects communities with >20% membership changes and re-queues them.

**Optional CI integration:**

If you want summarization triggered immediately after large commits rather than waiting for the nightly schedule, the indexer emits a `symbols-changed` event after each indexing run. Wire this to the summarization coordinator with a minimum change threshold to avoid triggers on single-line fixes:

```yaml
summarization:
  ciTrigger:
    enabled: true
    minSymbolsChanged: 10
```

---

## Rollback Playbook

If any phase introduces instability, use the following to revert the semantic layer while preserving structural data:

```cypher
-- Remove summary nodes and edges (Phase 4 rollback)
MATCH (ss:SymbolSummary) DETACH DELETE ss
MATCH (cs:CommunitySummary) DETACH DELETE cs

-- Remove vector indexes (Phase 3 rollback)
DROP INDEX symbol_summary_embedding IF EXISTS
DROP INDEX community_summary_embedding IF EXISTS

-- Remove git mining properties (Phase 3 partial rollback)
MATCH (s:Symbol) REMOVE s.changeFrequency, s.authorCount, s.lastModified, s.gitAge
```

The structural metrics data (Phase 1) and behavioral extraction data (Phase 2) are safe to leave in place during a semantic layer rollback. They do not affect existing MCP tools.
