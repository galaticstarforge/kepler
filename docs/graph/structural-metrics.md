# Structural Metrics

Structural metrics are pre-computed graph properties that describe the topology of the codebase. All of them are computed by Neo4j GDS algorithms against the existing `CALLS` and `IMPORTS` edges. No static analysis, no LLM, no source file reads. The computation is a batch GDS pass that runs after the base extraction pipeline completes and re-runs on a configurable schedule or on-demand via `admin.recomputeMetrics`.

The value is direct Cypher-answerability for a class of questions that otherwise require LLM inference or human familiarity with the codebase. See [graph/README.md](./README.md) for the full accounting of what becomes Cypher-answerable.

---

## Node Types Added

### `Community`

One `Community` node per detected cluster. Created by the GDS community detection pass.

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `communityId` | integer | GDS Leiden | Stable within a GDS run; may shift across runs as the graph changes |
| `repo` | string | GDS pass | Scoped per repo |
| `size` | integer | GDS pass | Number of member symbols |
| `cohesion` | float | GDS pass | Fraction of possible intra-community edges that actually exist; 0.0-1.0 |
| `coreCount` | integer | GDS pass | Members with `communityRole = 'core'` |
| `boundaryCount` | integer | GDS pass | Members with `communityRole = 'boundary'` |
| `label` | string | LLM (optional) | Human-readable cluster name; populated by the summarization pass if enabled |

**Index:**

```cypher
CREATE INDEX community_repo IF NOT EXISTS FOR (c:Community) ON (c.repo, c.communityId);
```

---

## Property Additions to `Symbol`

All structural metric properties are added to the existing `Symbol` node type. They are computed by GDS and written back to the node via the GDS write-back API.

| Property | Type | Populated By | Notes |
|---|---|---|---|
| `pageRank` | float | GDS PageRank | Computed on the `CALLS` projection. Higher = more central |
| `betweenness` | float | GDS Betweenness (approx) | Fraction of shortest paths passing through this symbol; normalized 0.0-1.0 |
| `fanIn` | integer | GDS degree | Incoming `CALLS` edge count |
| `fanOut` | integer | GDS degree | Outgoing `CALLS` edge count |
| `reachableFromEntry` | boolean | GDS BFS | True if reachable from any `Symbol` or `Module` where `isEntryPoint = true` |
| `depthFromEntry` | integer | GDS shortest path | Shortest-path hops from any entry point; -1 if unreachable |
| `communityId` | integer | GDS Leiden | Membership in the detected community |
| `communityRole` | string | GDS pass | `core`, `boundary`, or `bridge` (see below) |

**Role classification logic** (computed after community detection, before write-back):

```
intraCommunityEdges = count of CALLS edges to symbols in same community
interCommunityEdges = count of CALLS edges to symbols in different communities
totalEdges = intraCommunityEdges + interCommunityEdges

if totalEdges = 0:
    role = 'core'       (isolated or leaf symbol)
elif interCommunityEdges / totalEdges < 0.15:
    role = 'core'       (nearly all edges within community)
elif interCommunityEdges / totalEdges > 0.50:
    role = 'bridge'     (majority of edges cross community boundaries)
else:
    role = 'boundary'   (mix of intra and inter-community edges)
```

Bridge symbols are the seams between clusters. They are almost always worth examining first when trying to understand how parts of the system interact.

---

## Edge Types Added

### `MEMBER_OF` (Symbol → Community)

Links a symbol to its detected community.

| Property | Type | Notes |
|---|---|---|
| `role` | string | `core`, `boundary`, `bridge`; duplicated from node for fast edge-level traversal |
| `intraCommunityEdges` | integer | Edge count within the community |
| `interCommunityEdges` | integer | Edge count outside the community |

---

## GDS Computation

### Prerequisites

- GDS plugin installed and loaded in the Neo4j container (see [graph/README.md](./README.md)).
- The `CALLS` edge projection must be ready. GDS operates on named in-memory projections; the orchestrator creates and tears down projections as part of the enrichment pass.

### Projection

```cypher
CALL gds.graph.project(
  'calls-graph',
  {
    Symbol: {
      properties: ['isExported', 'isAsync']
    }
  },
  {
    CALLS: { orientation: 'NATURAL' }
  }
);
```

A separate `imports-graph` projection using the `IMPORTS` edge can be used for module-level metrics if needed. The v1 enrichment uses `CALLS` only; the module graph can be added later without schema changes.

### PageRank

```cypher
CALL gds.pageRank.write('calls-graph', {
  writeProperty: 'pageRank',
  maxIterations: 20,
  dampingFactor: 0.85
});
```

### Betweenness Centrality (approximate)

The exact betweenness algorithm is O(n * m) and impractical for large codebases. GDS ships RA-Brandes approximation, which is accurate enough for our purposes.

```cypher
CALL gds.betweenness.write('calls-graph', {
  writeProperty: 'betweenness',
  samplingSize: 5000
});
```

### Community Detection (Leiden)

```cypher
CALL gds.leiden.write('calls-graph', {
  writeProperty: 'communityId',
  gamma: 1.0,          -- resolution; lower = larger communities
  theta: 0.01,
  maxLevels: 10
});
```

Leiden is preferred over Louvain. It produces communities with better-defined boundaries and is less prone to the "disconnected community" artifact that Louvain can produce in sparse graphs. Both are available in GDS CE. The `gamma` parameter is tunable; the default of 1.0 produces communities of 10-80 symbols on typical JavaScript codebases. See the migration document for tuning guidance.

### Fan-In / Fan-Out

```cypher
CALL gds.degree.write('calls-graph', {
  writeProperty: 'fanOut',
  orientation: 'NATURAL'
});

CALL gds.degree.write('calls-graph', {
  writeProperty: 'fanIn',
  orientation: 'REVERSE'
});
```

### Reachability from Entry Points

Entry points are identified by convention: `Module.isEntryPoint = true` (set by the base extractor for files matching configured entry patterns) or `Symbol.isExported = true AND Symbol.kind = 'function' AND module.isBarrel = false`.

The BFS approach via `gds.bfs.write` writes the shortest-path distances. Symbols not reached get `depthFromEntry = -1`.

```cypher
MATCH (entry:Symbol {isExported: true})
WHERE NOT exists { MATCH (entry)<-[:CALLS]-() }   // no callers = likely entry
WITH collect(id(entry)) AS entryIds

CALL gds.bfs.write('calls-graph', {
  sourceNodes: entryIds,
  writeProperty: 'depthFromEntry'
});

// Mark reachable
MATCH (s:Symbol) WHERE s.depthFromEntry >= 0 SET s.reachableFromEntry = true;
MATCH (s:Symbol) WHERE s.depthFromEntry IS NULL SET s.reachableFromEntry = false, s.depthFromEntry = -1;
```

### Community Role Assignment

After Leiden runs, compute roles in a separate pass:

```cypher
MATCH (s:Symbol)
OPTIONAL MATCH (s)-[out:CALLS]->(target:Symbol)
WITH s,
  sum(CASE WHEN target.communityId = s.communityId THEN 1 ELSE 0 END) AS intra,
  sum(CASE WHEN target.communityId <> s.communityId THEN 1 ELSE 0 END) AS inter
WITH s, intra, inter, intra + inter AS total
SET s.communityRole = CASE
  WHEN total = 0 THEN 'core'
  WHEN toFloat(inter) / total > 0.50 THEN 'bridge'
  WHEN toFloat(inter) / total > 0.15 THEN 'boundary'
  ELSE 'core'
END;
```

### Community Node Creation

After member roles are set, create `Community` nodes and `MEMBER_OF` edges:

```cypher
// Create Community nodes
MATCH (s:Symbol)
WITH s.communityId AS cid, s.repo AS repo, count(s) AS sz
MERGE (c:Community {communityId: cid, repo: repo})
SET c.size = sz;

// Create MEMBER_OF edges
MATCH (s:Symbol), (c:Community {communityId: s.communityId, repo: s.repo})
MERGE (s)-[r:MEMBER_OF]->(c)
SET r.role = s.communityRole;
```

---

## Scheduling

GDS passes run as a separate orchestrator pass after the base extraction and analysis passes complete. They do not run incrementally; they re-run on the full `CALLS` graph. The typical runtime on a 100-repo codebase with 500K nodes is 3-8 minutes. This pass is triggered:

1. After any full re-index.
2. After an incremental pass that changes more than a configurable threshold of `CALLS` edges (default: 5% of total edges).
3. On demand via `admin.recomputeMetrics`.

Community IDs are not stable across runs when the graph changes significantly. This is expected and documented. Any downstream system (including the summarization pass) that stores a `communityId` reference should re-validate it on the next metrics run. The `Community` nodes are replaced, not updated, on each run.

---

## Failure Modes

**Community instability.** Leiden community IDs are not persistent identifiers. A large refactor can cause the entire community partition to shift. The summarization layer must handle stale `communityId` references gracefully, which it does by re-resolving community membership before each summarization pass.

**GDS projection memory.** For codebases with millions of nodes, the in-memory GDS projection can exhaust heap. The orchestrator checks available heap before projecting and fails fast with a clear error. Instance sizing guidance in the deployment docs sets the minimum for GDS-enabled deployments at m7i.2xlarge (32 GB RAM).

**Betweenness sampling variance.** The RA-Brandes approximation introduces noise proportional to `1 / sqrt(samplingSize)`. At `samplingSize = 5000`, the relative error is approximately 1.4%. This is acceptable for ranking purposes but means betweenness scores are not exact. Treat betweenness as an ordinal signal, not a precise measurement.

**Entry-point heuristic false positives.** The heuristic that treats exported symbols with no callers as entry points is imprecise. Library packages export many symbols that are not entry points in the traditional sense. The `reachableFromEntry` property should be treated as an approximation. Future versions may support explicit entry point declaration in the repo config.
