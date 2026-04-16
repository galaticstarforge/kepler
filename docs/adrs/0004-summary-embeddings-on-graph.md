# ADR-0004: Summary Embeddings Stored on Graph Nodes

**Status:** Accepted  
**Date:** 2026-04-16

---

## Context

The summarization subsystem generates natural-language descriptions of code symbols and communities. These descriptions need to be retrieved semantically: a developer searching "find functions that handle payment retries" should get back summaries whose content semantically matches that query, even without exact keyword overlap.

Semantic retrieval requires vector embeddings and an approximate nearest-neighbor index. The question is where to store the embeddings and how to serve vector queries.

Three options:

1. **External vector store** (Pinecone, Weaviate, OpenSearch with k-NN, Bedrock Knowledge Base). Embeddings live outside Neo4j. Vector queries hit the external store and return IDs. IDs are then federated back to Neo4j for graph context. Good operational separation of concerns. Adds a second stateful service. Requires coordination between two stores for updates (delete old embedding when summary is regenerated).

2. **Bedrock Knowledge Base.** Amazon Bedrock's managed knowledge base with automatic chunking, embedding, and retrieval. Minimal operational overhead for pure retrieval. Loses the property that retrieval results can be immediately enriched with graph traversal (caller/callee, community membership, etc.) in a single query. Results are chunks; mapping them back to specific `Symbol` nodes requires a secondary lookup.

3. **Native Neo4j vector indexes.** Neo4j 5.11+ supports `CREATE VECTOR INDEX` and `db.index.vector.queryNodes()`. Embeddings are stored directly on `SymbolSummary` and `CommunitySummary` nodes. Vector queries and graph traversal execute in the same database transaction.

The third option is decisively simpler for this use case. The primary MCP consumer pattern is "semantically find a symbol, then get its graph context." With a native index, that is one Cypher query. With an external store, that is a vector query, a parse step, and a graph query. The operational overhead difference is also significant: no second stateful service to provision, back up, or authenticate against.

---

## Decision

Embeddings are stored directly on `SymbolSummary.embedding` and `CommunitySummary.embedding` as `float[]` properties. Native Neo4j vector indexes are created on both:

```cypher
CREATE VECTOR INDEX symbol_summary_embedding
FOR (s:SymbolSummary) ON (s.embedding)
OPTIONS {
  indexConfig: {
    `vector.dimensions`: 1536,
    `vector.similarity_function`: 'cosine'
  }
}

CREATE VECTOR INDEX community_summary_embedding
FOR (c:CommunitySummary) ON (c.embedding)
OPTIONS {
  indexConfig: {
    `vector.dimensions`: 1536,
    `vector.similarity_function`: 'cosine'
  }
}
```

Vector queries in Cypher:

```cypher
CALL db.index.vector.queryNodes('symbol_summary_embedding', 5, $queryEmbedding)
YIELD node AS summary, score
MATCH (sym:Symbol)-[:HAS_SUMMARY]->(summary)
RETURN sym.name, sym.filePath, summary.purpose, summary.semanticTags, score
```

The `embeddingModel` field on each summary node records which model generated the embedding. If the embedding model changes, all summaries need their embeddings regenerated and the index must be dropped and recreated.

---

## Consequences

### What This Enables

- Single-query semantic search with graph context. An MCP handler for `graph.semanticSearch` can return symbol name, module, callers, community name, and summary quality tier in one round trip to Neo4j.
- No coordination between two stores. When a `SymbolSummary` is updated, the embedding is updated in the same write operation. There is no dual-write, no eventual consistency lag, and no reconciliation job.
- The Kepler deployment footprint stays at one stateful service for graph and vector operations. This matters for the self-hosted deployment model: operators running Kepler against a private codebase do not want to provision and manage a Pinecone account.
- Backup and recovery are simpler. A Neo4j backup includes both the graph and the vector indexes.

### What This Costs

- Neo4j 5.11 is the minimum version required. Neo4j CE 5.11 supports native vector indexes. This version constraint must be documented in the migration guide and checked on startup.
- Memory requirements for Neo4j increase. A 1536-dimension float[] embedding for 50,000 symbols is approximately 300MB of embedding data, plus index overhead. Memory sizing guidance is in the migration doc; the minimum recommended is 8GB heap for codebases above 20,000 symbols with full summarization coverage.
- If the embedding model changes, all embeddings must be regenerated. This is a full-codebase re-embedding pass, which is not trivially cheap. The `embeddingModel` field makes model changes detectable; the migration tooling will warn when `embeddingModel` values in the graph do not match the configured model.

### Failure Modes

- **Index not yet built on first query.** The vector index builds asynchronously after creation. Queries during the build phase return no results. The MCP server should check index state on startup and respond with a `503 Service Unavailable` for vector queries until the index is `ONLINE`.
- **Dimension mismatch.** If an embedding is generated with a model that produces 768-dimensional vectors but the index is configured for 1536 dimensions, the write will fail with a constraint error. The summarization agent validates the embedding dimension against the configured index dimensions before writing.
- **Large float[] property on dense graphs.** For Neo4j CE without enterprise hardware resources, storing a 6,144-byte property on hundreds of thousands of nodes can cause page cache pressure. Monitor page cache hit rate; if it drops below 95%, increase Neo4j heap or move to instance storage with faster I/O.

---

## Alternatives Considered

**Pinecone or Weaviate:** good operational tradeoffs for teams already running external vector stores. The main argument against for Kepler is that it adds a service dependency for a self-hosted tool. A plugin extension point could allow external vector stores in the future without changing the default.

**Bedrock Knowledge Base:** excellent for RAG over documents. Less appropriate here because the retrieval unit (a summary node) maps directly to a graph node, and it would require chunks from Bedrock to be correlated back to node IDs. The coupling between retrieval and graph traversal is too tight to benefit from Bedrock KB's chunk-based model.

**No vector search; keyword search only.** Would work for `graph.symbolContext` (exact name lookup), but not for the "find functions that handle payment retries" query pattern. Semantic search over code summaries is qualitatively different from keyword search; the vocabulary used in queries rarely matches the vocabulary in function names.

---

## Open Question

Should `SymbolSummary` text content also be indexed in the Bedrock Knowledge Base alongside the markdown documentation corpus, to give a unified semantic search surface that spans docs and code? The argument for: developers search for concepts, not for "is this a doc or a symbol." The argument against: the knowledge base chunking model does not preserve the symbol-to-graph-node mapping, so the unified search result is less enrichable than a pure graph result. This question is deferred to v2.
