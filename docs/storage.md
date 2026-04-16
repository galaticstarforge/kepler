# Storage Layer

The system depends on four storage subsystems. Each one is abstracted behind an interface, which means you can swap implementations without touching the rest of the system. I think that abstraction boundary matters more in practice than it might seem at first, because the target deployment environment and the development environment are different enough that having plug-in backends is genuinely useful. Alternatives exist for other environments and for local development.

---

## Graph Store

**Single backend: Neo4j Community Edition 5.x.** This is not an arbitrary choice. Cypher's expressiveness is load-bearing for the MCP graph query surface, and the set of graph databases that match Neo4j's query ergonomics and tool ecosystem is small. The system does not define an abstract `GraphStore` interface in v1. Neo4j-specific Cypher is used throughout. A future refactor is possible but not planned.

### Connection Management

- Bolt protocol on port 7687.
- Connection pool sized per-process: 50 for the MCP server, 10 for the orchestrator, 5 for the enrichment cron.
- Automatic retry with exponential backoff on transient errors.
- All writes use `UNWIND`-based batch upserts. Single-node writes are not permitted in production paths.
- Transaction scope is per-pass: one transaction per pass execution, rolled back on failure.

### Schema Management

Indexes and constraints are declared in code and applied at orchestrator startup. Core ships with a canonical set. Plugins declare their own indexes via the `schema.nodes[].indexes` field; the orchestrator applies them on plugin registration.

Full-text indexes are declared separately from b-tree indexes.

### Core Indexes

```cypher
CREATE INDEX module_lookup IF NOT EXISTS FOR (m:Module) ON (m.repo, m.path);
CREATE INDEX symbol_lookup IF NOT EXISTS FOR (s:Symbol) ON (s.repo, s.filePath, s.name);
CREATE INDEX symbol_by_name IF NOT EXISTS FOR (s:Symbol) ON (s.name);
CREATE INDEX reference_location IF NOT EXISTS FOR (r:Reference) ON (r.repo, r.filePath, r.line);
CREATE INDEX callsite_location IF NOT EXISTS FOR (cs:CallSite) ON (cs.repo, cs.filePath, cs.line);
CREATE INDEX scope_lookup IF NOT EXISTS FOR (s:Scope) ON (s.repo, s.filePath, s.lineStart);
CREATE INDEX comment_type IF NOT EXISTS FOR (c:Comment) ON (c.kind);
CREATE INDEX document_path IF NOT EXISTS FOR (d:Document) ON (d.path);
CREATE INDEX document_type IF NOT EXISTS FOR (d:Document) ON (d.type, d.status);
CREATE INDEX document_service IF NOT EXISTS FOR (d:Document) ON (d.service);

CREATE FULLTEXT INDEX symbol_name_ft IF NOT EXISTS
  FOR (s:Symbol) ON EACH [s.name, s.signature];
CREATE FULLTEXT INDEX comment_text_ft IF NOT EXISTS
  FOR (c:Comment) ON EACH [c.text];
CREATE FULLTEXT INDEX literal_value_ft IF NOT EXISTS
  FOR (l:LiteralValue) ON EACH [l.rawValue];
```

---

## Document Store

The document store handles raw markdown CRUD. Everything above that (rendering, frontmatter extraction, semantic indexing) is the consumer's responsibility.

### Interface

```typescript
interface DocumentStore {
  get(path: string): Promise<DocumentBytes | null>;
  put(path: string, content: Buffer, metadata: DocumentMetadata): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): AsyncIterable<DocumentHead>;
  watch(): AsyncIterable<DocumentStoreEvent>;
  head(path: string): Promise<DocumentHead | null>;
}
```

### Implementations

**Default: AWS S3.** Uses native S3 events via EventBridge and SQS for the `watch()` method. Versioning and lifecycle policies are configurable at the bucket level but not managed by the system.

**Alternative: Local filesystem.** Intended for development and small single-user deployments. Uses `chokidar` for `watch()`.

Other implementations not shipped but anticipated: Azure Blob Storage, Google Cloud Storage, MinIO, any S3-API-compatible store.

---

## Semantic Index

The semantic index handles doc indexing and search. It does not extract frontmatter. That happens upstream. It receives structured documents with metadata already parsed.

### Interface

```typescript
interface SemanticIndex {
  upsert(doc: IndexableDocument): Promise<void>;
  delete(path: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  status(): Promise<IndexStatus>;
}

interface IndexableDocument {
  path: string;
  content: string;     // markdown stripped to plain text
  metadata: Record<string, string>;  // frontmatter for filtering
}

interface SearchOptions {
  limit?: number;
  filter?: Record<string, string>;
  minScore?: number;
}
```

### Implementations

**Default: AWS Bedrock Knowledge Base.** Configuration points at an existing KB that is wired to the S3 bucket. The system does not manage the KB's data source configuration. That is a one-time AWS setup step documented in deployment.

**Alternative: pgvector.** Uses a Postgres instance (typically serverless-v2 Aurora) with the `pgvector` extension. Embedding provider is configurable: AWS Bedrock (Titan), OpenAI, or a local model via Ollama. This path is for deployments that cannot or do not want to use Bedrock KB.

**Development convenience: SQLite with `sqlite-vec`.** Not recommended for production.

---

## Source Access

Source files are read from bare git clones on the host filesystem. An abstraction exists to allow future variations (direct S3-backed repos, remote git reads), but the current implementation is direct filesystem access against bare clones.

### Interface

```typescript
interface SourceAccess {
  readFile(repo: string, path: string, commitSha: string): Promise<Buffer>;
  listFiles(repo: string, commitSha: string): AsyncIterable<FileEntry>;
  diff(repo: string, fromSha: string, toSha: string): AsyncIterable<FileDiff>;
  currentHead(repo: string): Promise<string>;
}
```

The implementation shells out to git binaries: `git show`, `git ls-tree`, `git diff --name-status`, `git rev-parse`. Results are cached in-memory per-run to avoid redundant git operations within a single pass execution.
