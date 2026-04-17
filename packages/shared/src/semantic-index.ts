/**
 * SemanticIndex interface and supporting types.
 *
 * The semantic index handles document indexing and search. It receives
 * structured documents with metadata already parsed — it does not
 * extract frontmatter.
 */

/** A document ready for indexing (plain text, not markdown). */
export interface IndexableDocument {
  path: string;
  /** Markdown stripped to plain text. */
  content: string;
  /** Frontmatter fields flattened to string values for filtering. */
  metadata: Record<string, string>;
}

export interface SearchOptions {
  limit?: number;
  filter?: Record<string, string>;
  minScore?: number;
}

export interface SearchResult {
  path: string;
  score: number;
  snippet: string;
  metadata: Record<string, string>;
}

export interface IndexStatus {
  provider: string;
  documentCount: number;
  lastSyncedAt: Date | null;
  healthy: boolean;
}

/**
 * Abstract semantic index. Implementations handle embedding, storage,
 * and vector search. The default is AWS Bedrock Knowledge Base.
 */
export interface SemanticIndex {
  upsert(doc: IndexableDocument): Promise<void>;
  delete(path: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  status(): Promise<IndexStatus>;
}
