# Architecture

This document covers the system's components, what each one owns, and how data flows through the system. For context on why things are designed this way, start with the [overview](./README.md).

---

## Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Host (EC2 / Container)                       │
│                                                                      │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │   MCP Server   │  │   Neo4j CE   │  │  Orchestrator Process   │  │
│  │                │  │              │  │                         │  │
│  │  - docs.*      │◄─┤  Graph DB    │◄─┤  - Git watcher          │  │
│  │  - graph.*     │  │              │  │  - File discovery        │  │
│  │  - plugin MCP  │  │              │  │  - Base extraction       │  │
│  │    tools       │  │              │  │  - Analysis passes       │  │
│  │                │  │              │  │  - Enrichment pipeline   │  │
│  └────────┬───────┘  └──────────────┘  └────────────┬────────────┘  │
│           │                                          │               │
│           │          ┌───────────────────┐           │               │
│           │          │ Bare git clones   │◄──────────┘               │
│           │          │  (shared volume)  │                           │
│           │          └───────────────────┘                           │
│           │                                                          │
│           ▼                                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Storage Adapters                                             │   │
│  │  - DocumentStore (S3 default, filesystem alternative)        │   │
│  │  - SemanticIndex (Bedrock KB default, pgvector alternative)  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
           │                          │                       │
        (markdown)           (semantic search)          (MCP client)
```

---

## Component Responsibilities

Each component has a clear owner and a clear boundary. The table below describes what each component owns and, just as importantly, what it does not own. I think blurring these lines is where most complexity in a system like this comes from.

| Component | Owns | Does Not Own |
|---|---|---|
| **Orchestrator** | Pipeline execution, DAG resolution, scheduling | Parsing, graph queries, MCP transport |
| **Git Watcher** | Clone management, fetch polling, diff detection | File content interpretation |
| **File Discovery** | Enumerating files, applying ignore patterns, hash caching | File parsing |
| **Base Extractor** | JavaScript AST → primitives; core-shipped | Non-JS languages (that is a plugin) |
| **Pass Runners** | Core analysis passes | Plugin-specific logic |
| **Plugin Registry** | Plugin loading, schema validation, dependency resolution | Plugin implementation |
| **Graph Client** | Neo4j connection management, batched upserts, query cache | Schema evolution |
| **Document Store** | Markdown CRUD against configured backend | Markdown rendering or editing |
| **Semantic Index** | Doc indexing and search against configured backend | Frontmatter extraction |
| **MCP Server** | Tool surface, auth, rate limiting, transport | Tool implementation logic |
| **Doc Enrichment** | Scheduled job linking code graph to documentation | On-demand lookups |

---

## Data Flow

### Indexing (initial or incremental)

This is the core pipeline. Everything starts here.

1. The Git watcher detects changes via commit SHA diff, or triggers when a repo is first cloned.
2. File discovery enumerates changed files, applies ignore rules, and computes content hashes.
3. For each discovered file, plugin `fileReaders` are queried in declaration order. The first claimer handles extraction. The core JS extractor handles any unclaimed `.js` files.
4. Extracted primitives are written to Neo4j in batched transactions.
5. Analysis passes run in DAG order. Core passes run first, then plugin enrichments.
6. Pass outputs are written to Neo4j.
7. State is persisted: last-indexed SHA, pass-run timestamps.

The incremental path is intentional. Step 2's hash caching is what makes it possible to skip files that have not changed. Full re-analysis is the fallback, not the default.

### Documentation

1. Markdown files are stored in S3 under a defined hierarchy with structured frontmatter.
2. The semantic index is kept in sync via S3 event triggers or periodic sync.
3. A doc enrichment cron periodically walks the doc corpus, extracts symbol references, queries the graph, and updates "Related Code" sections.
4. The MCP server answers `docs.*` queries by combining structured S3 access with semantic search results.

### Query

1. An MCP client (like Claude Code) connects to the MCP server over SSE with a bearer token.
2. Tool invocations are authenticated, rate-limited, and dispatched to the relevant handler.
3. Handlers query Neo4j for `graph.*` tools, S3 plus the semantic index for `docs.*` tools, or plugin-registered handlers for anything else.
4. Results are serialized and returned.

This flow is intentionally stateless at the query layer. The graph and the document store are the only state. A request comes in, gets dispatched, answer comes back. There is no session state to manage.
