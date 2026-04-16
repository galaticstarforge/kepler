/**
 * DocumentStore interface and supporting types.
 *
 * The document store handles raw markdown CRUD. Everything above that
 * (rendering, frontmatter extraction, semantic indexing) is the
 * consumer's responsibility.
 */

/** Raw bytes + metadata returned from a get(). */
export interface DocumentBytes {
  content: Buffer;
  metadata: DocumentMetadata;
  etag?: string;
  lastModified?: Date;
}

/** Metadata stored alongside a document. */
export interface DocumentMetadata {
  contentType: string;
  contentLength: number;
  lastModified: Date;
  etag?: string;
  /** Arbitrary key-value pairs (frontmatter-derived, user-supplied, etc.). */
  custom: Record<string, string>;
}

/** Lightweight listing entry (no body). */
export interface DocumentHead {
  path: string;
  metadata: DocumentMetadata;
}

export type DocumentStoreEventType = 'created' | 'updated' | 'deleted';

/** Change event emitted by watch(). */
export interface DocumentStoreEvent {
  type: DocumentStoreEventType;
  path: string;
  timestamp: Date;
  metadata?: DocumentMetadata;
}

/**
 * Abstract document store. Implementations handle raw bytes and metadata;
 * callers are responsible for parsing frontmatter and indexing content.
 */
export interface DocumentStore {
  get(path: string): Promise<DocumentBytes | null>;
  put(path: string, content: Buffer, metadata: DocumentMetadata): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): AsyncIterable<DocumentHead>;
  watch(): AsyncIterable<DocumentStoreEvent>;
  head(path: string): Promise<DocumentHead | null>;
}
