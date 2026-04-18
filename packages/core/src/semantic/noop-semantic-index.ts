import type {
  IndexableDocument,
  IndexStatus,
  SearchOptions,
  SearchResult,
  SemanticIndex,
} from '@keplerforge/shared';

/**
 * No-op semantic index for testing and deployments where semantic
 * search is not configured. All methods succeed but do nothing.
 */
export class NoopSemanticIndex implements SemanticIndex {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async upsert(doc: IndexableDocument): Promise<void> {
    // no-op
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async delete(path: string): Promise<void> {
    // no-op
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return [];
  }

  async status(): Promise<IndexStatus> {
    return {
      provider: 'none',
      documentCount: 0,
      lastSyncedAt: null,
      healthy: true,
    };
  }
}
