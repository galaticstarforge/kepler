# Enriched Graph Layer

The graph that ships with Kepler v1 is a strong structural index of source code. It answers questions about module topology, call graphs, symbol definitions, and import relationships efficiently. What it does not answer well is anything semantic: what this function actually does, which part of the codebase handles a given concept, or which functions are risky to change because they're both high-traffic and high-volatility.

I think the right framing for this gap is: the v1 graph is a map of *structure*, not a map of *meaning*. Structure is necessary but not sufficient for the kind of retrieval a coding agent needs when it's trying to understand an unfamiliar codebase.

The additions in this section address that gap in layers. The strategy is to pre-compute as much as possible through static analysis and graph algorithms, so that many questions that currently require LLM interpretation become direct Cypher queries. The LLM layer handles only the genuinely semantic residue.

---

## Three Categories of Addition

**[Structural Metrics](./structural-metrics.md)** pre-computed centrality, community membership, and reachability properties. These are computed entirely by Neo4j GDS (Graph Data Science plugin), with no LLM involvement. They make "find the most connected symbols," "find the architectural clusters," and "find what changed the most" into Cypher queries.

**[Behavioral Extraction](./behavioral-extraction.md)** statically derivable properties about what code does: I/O, mutation, thrown errors, config reads, feature flag checks, external service calls, and test-to-production linkage. These are extracted by static analysis passes and git mining. They make "find all functions that talk to Stripe" or "find all paths to the payment service" into graph traversals.

**[Semantic Enrichment](./semantic-enrichment.md)** LLM-generated summary nodes with vector embeddings stored directly on graph nodes, docstrings surfaced as properties, architectural layer and bounded-context tags, and git-derived volatility signals. This is the residue that structural analysis cannot close: natural-language purpose, semantic tags, example-driven understanding.

---

## What Becomes Cypher-Answerable

The point of the first two layers is to shift as many queries as possible out of the LLM and into Cypher. A query that runs in milliseconds against the graph is cheaper, faster, and more deterministic than one that requires model inference. Here is a concrete accounting of what the enriched graph makes directly answerable:

| Question | Pre-enrichment | Post-enrichment |
|---|---|---|
| What are the most central symbols in this service? | LLM guess | `WHERE s.pageRank > 0.5 ORDER BY s.pageRank DESC` |
| Which functions produce side effects? | LLM inference | `WHERE s.hasIO = true OR s.hasMutation = true` |
| What functions can throw `PaymentError`? | LLM inference | `MATCH (s)-[:THROWS]->(e {errorType: 'PaymentError'})` |
| What config keys does this service read? | LLM inference | `MATCH (s)-[:READS_CONFIG]->(c) RETURN c.key` |
| Which symbols changed most in the last 90 days? | Not answerable | `ORDER BY s.changeFrequency DESC` |
| Which symbols are in the same architectural cluster? | Not answerable | `WHERE s.communityId = $id` |
| What calls the Stripe API? | LLM inference | `MATCH (s)-[:CALLS_SERVICE]->(e {name: 'stripe'})` |
| Which symbols have test coverage? | LLM guess | `MATCH (t)-[:TEST_ASSERTS]->(s) RETURN s` |
| What are the boundary symbols between clusters? | Not answerable | `WHERE s.communityRole = 'boundary'` |
| What symbols are exported but never called externally? | Partial | `WHERE s.isPublicApi AND s.fanIn = 0` |

The LLM summary layer then handles what's left: *what does this do*, *what concept does this implement*, *why does this exist*. That's the residue the graph cannot answer without natural language generation.

---

## Infrastructure Requirements

These additions have one hard dependency not present in v1: the **Neo4j Graph Data Science (GDS) plugin**.

GDS is a separate plugin from the Neo4j database. The community edition of GDS is free and includes all the algorithms we need: PageRank, betweenness centrality (approximate via RA-Brandes), Louvain community detection, and Leiden community detection (GDS 2.3+). It is installed by adding the plugin JAR to the Neo4j container.

The Docker Compose configuration for the `neo4j` service gains one environment variable:

```yaml
environment:
  NEO4J_PLUGINS: '["graph-data-science"]'
```

This triggers automatic plugin download when the container starts. If the deployment is airgapped, the JAR can be pre-bundled in a custom image instead.

**Minimum Neo4j version: 5.11.** Vector index support (`CREATE VECTOR INDEX`) was added in 5.11. The v1 docs specify Neo4j CE 5.x without pinning a minor version. This enrichment layer requires ≥ 5.11.

**Open question:** The GDS in-memory projection approach loads a subgraph into RAM. For large codebases, this can be significant. A codebase with 500,000 nodes and 2M relationships may require 4-8 GB of heap for GDS projections. The instance sizing guidance in the deployment docs should be revisited before running GDS at scale. I will note this in the migration document.

---

## Document Map

- [Structural Metrics](./structural-metrics.md): PageRank, betweenness, fan-in/out, community detection, community roles, reachability from entry points.
- [Behavioral Extraction](./behavioral-extraction.md): Effects, throws/catches edges, read/write sets, config reads, feature flag references, external service calls, test-to-production linkage.
- [Semantic Enrichment](./semantic-enrichment.md): Summary nodes, vector indexes, docstrings, architectural layers, bounded contexts, git volatility signals, public-surface annotations.
