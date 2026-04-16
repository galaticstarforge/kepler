# MCP Server

The MCP server is the primary access point for AI clients. I think of everything else in the system as infrastructure that exists to make these tools useful. It exposes a set of tools grouped by namespace, enforces auth and rate limiting, and routes requests to the appropriate handlers.

---

## Transport

**Primary: SSE over HTTPS.** Clients establish a long-lived connection and receive tool invocations and responses over the stream.

**Secondary: stdio**, for local development and testing.

The server does not implement a WebSocket transport in v1. The MCP specification's SSE transport is sufficient and has better proxy and load-balancer compatibility.

---

## Authentication

Bearer token authentication. Tokens are generated out-of-band by an administrator and stored in a secrets backend (AWS Secrets Manager by default, environment variables as a fallback).

- Each token has a name, optional scopes, and an expiration.
- Scopes restrict which tools are callable: `docs:read`, `docs:write`, `graph:read`, `graph:write`, `admin:*`.
- Invalid or expired tokens produce an immediate connection close with a 401-equivalent MCP error.
- Token validation is cached in-memory for 60 seconds to limit secrets-fetch load.

IP allowlisting is handled at the transport layer (API Gateway WAF, security group rules). The server itself does not implement IP allowlisting.

---

## Rate Limiting

Per-token rate limits, enforced via a token-bucket algorithm. Exceeded limits produce a `rate-limited` MCP error with a `retryAfter` hint.

```yaml
mcp:
  rateLimits:
    defaults:
      requestsPerMinute: 60
      requestsPerHour: 500
    perToken:
      - name: claude-code-prod
        requestsPerMinute: 120
        requestsPerHour: 2000
```

---

## Tool Surface

Tools are organized under two core namespaces: `docs.*` and `graph.*`. Plugins may register additional namespaces.

### `docs.*` Tools

| Tool | Purpose | Scope |
|---|---|---|
| `docs.create` | Create a new document at a canonical path. | `docs:write` |
| `docs.read` | Read a document by path. | `docs:read` |
| `docs.update` | Update an existing document. | `docs:write` |
| `docs.delete` | Delete a document. (Reversible via S3 versioning.) | `docs:write` |
| `docs.list` | List documents under a prefix. | `docs:read` |
| `docs.search` | Semantic search over the corpus with metadata filters. | `docs:read` |
| `docs.propose` | Write a draft to `.claude/proposals/`. | `docs:write` |
| `docs.listTemplates` | Enumerate available document templates. | `docs:read` |
| `docs.applyTemplate` | Create a document from a template with substitutions. | `docs:write` |

`docs.search` is the main discovery path for documentation. It accepts a natural language query and an optional filter object matching frontmatter fields. The filter supports exact match on `type`, `status`, `service`, `domain`, and `author`.

### `graph.*` Tools

| Tool | Purpose | Scope |
|---|---|---|
| `graph.query` | Execute a parameterized Cypher query. | `graph:read` |
| `graph.findSymbol` | Find symbols by name, kind, and location filters. | `graph:read` |
| `graph.symbolDetails` | Get full details of a symbol including annotations. | `graph:read` |
| `graph.callers` | Transitive callers of a symbol. | `graph:read` |
| `graph.callees` | Transitive callees of a symbol. | `graph:read` |
| `graph.impactOf` | Functions and modules affected by changes to a symbol. | `graph:read` |
| `graph.relatedDocs` | Documents that reference a given graph entity. | `graph:read` |
| `graph.symbolsInDoc` | Graph entities referenced by a document. | `graph:read` |
| `graph.moduleGraph` | Import graph of modules matching a filter. | `graph:read` |
| `graph.listServices` | Enumerate indexed services with metadata. | `graph:read` |
| `graph.serviceTopology` | Service-to-service relationships across the indexed set. | `graph:read` |

`graph.query` is the escape hatch for advanced queries. It accepts arbitrary parameterized Cypher but enforces hard limits:

- Read-only. Any `CREATE`, `MERGE`, `SET`, `DELETE`, or `REMOVE` is rejected.
- Maximum execution time: 10 seconds.
- Maximum result rows: 1,000.
- Query must use parameters. String concatenation of user input is rejected.

### Enriched Graph Tools (`graph.*`)

These tools are available after the enriched graph layer is deployed. They require the structural metrics pass (for community and centrality data) and the summarization pass (for semantic search and context packs).

| Tool | Purpose | Scope |
|---|---|---|
| `graph.semanticSearch` | Vector similarity search over `SymbolSummary` and `CommunitySummary` embeddings. Returns symbols ranked by semantic relevance to a natural-language query. | `graph:read` |
| `graph.symbolContext` | Returns a self-contained context pack for a symbol: its canonical or provisional summary, top callers, top callees, community name, architectural layer, and links to related documents. | `graph:read` |
| `graph.communityContext` | Returns a `CommunitySummary` plus the canonical summaries of the community's bridge and core symbols. Useful for orienting an AI client to an unfamiliar subsystem. | `graph:read` |

`graph.semanticSearch` accepts a `query` string, an optional `kind` filter (`Symbol | Community`), and a `topK` parameter (default 5, max 20). Results include `tier` and `validationStatus` from the underlying summary so callers can decide how much to trust the semantic description.

`graph.symbolContext` accepts a symbol ID or qualified name. If the symbol has no summary yet, it returns structural metadata only and sets `summaryAvailable: false`. Clients should handle this gracefully.

`graph.communityContext` accepts a `communityId` integer or a natural-language community name (matched via vector search). The community name match uses the `community_summary_embedding` index and returns the closest match.

### `admin.*` Tools (Restricted Scope)

| Tool | Purpose |
|---|---|
| `admin.reindex` | Trigger an immediate reindex of a repo or all repos. |
| `admin.pluginStatus` | List registered plugins and their health. |
| `admin.passRunHistory` | Show recent pass executions with durations and errors. |
| `admin.enrichmentRun` | Trigger an immediate enrichment cron run. |
| `admin.diagnostics` | System health, queue depths, index sizes. |
| `admin.summarizationCoverage` | Current summarization coverage report: canonical pct, stale count, estimated cost for a full re-run. |
| `admin.triggerSummarization` | Queue specific repos or communities for (re-)summarization. Accepts `mode: 'full' \| 'incremental' \| 'upgrade'`. |
| `admin.recomputeMetrics` | Trigger a GDS structural metrics recomputation. Use after major refactors or when community assignments appear stale. |

---

## Response Shape

All MCP tool responses follow the MCP protocol's content-block format. The system uses three block types:

- `text`: human-readable responses.
- `resource`: references to documents or symbols that clients may follow up on.
- `structured`: JSON-serializable objects for programmatic consumption.

Most tools return a mix. For example, `graph.callers` returns a text summary block followed by structured blocks per caller with location, signature, and a resource URL pointing to the symbol.

---

## Tracing

Every MCP request gets a trace ID. That ID is propagated through to every graph query, document read, and plugin handler invocation. Logs include the trace ID, which makes full request reconstruction possible. Traces are emitted to standard output as structured JSON and can be shipped to any log ingestion system. See [observability](./observability.md) for details.
