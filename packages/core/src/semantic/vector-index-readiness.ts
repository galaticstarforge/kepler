import type { GraphClient } from '../graph/graph-client.js';
import { VECTOR_INDEX_NAMES } from '../graph/schema.js';
import type { Logger } from '../logger.js';
import { createLogger } from '../logger.js';

export interface VectorIndexState {
  name: string;
  state: 'ONLINE' | 'POPULATING' | 'FAILED' | 'MISSING' | string;
}

export interface VectorIndexReadinessSnapshot {
  ready: boolean;
  indexes: VectorIndexState[];
  checkedAt: string;
}

export interface VectorIndexReadinessDeps {
  graph: GraphClient;
  logger?: Logger;
  /** Minimum interval between live Neo4j queries. Defaults to 2 000 ms. */
  cacheTtlMs?: number;
  /** Overrides the wall clock; mainly useful for tests. */
  now?: () => number;
}

/**
 * Polls `SHOW INDEXES` on demand and caches the last result briefly so
 * `/ready` and `graph.semanticSearch` don't hammer Neo4j.
 */
export class VectorIndexReadiness {
  private readonly log: Logger;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: { snapshot: VectorIndexReadinessSnapshot; at: number } | null = null;

  constructor(private readonly deps: VectorIndexReadinessDeps) {
    this.log = deps.logger ?? createLogger('vector-index-readiness');
    this.cacheTtlMs = deps.cacheTtlMs ?? 2000;
    this.now = deps.now ?? (() => Date.now());
  }

  async snapshot(options: { force?: boolean } = {}): Promise<VectorIndexReadinessSnapshot> {
    const now = this.now();
    if (!options.force && this.cache && now - this.cache.at < this.cacheTtlMs) {
      return this.cache.snapshot;
    }

    const expected = [
      VECTOR_INDEX_NAMES.symbolSummary,
      VECTOR_INDEX_NAMES.communitySummary,
    ];

    let states: Array<{ name: string; state: string; type: string }>;
    try {
      states = await this.deps.graph.indexStates(expected);
    } catch (error) {
      this.log.warn('vector index probe failed', { error: String(error) });
      const snapshot: VectorIndexReadinessSnapshot = {
        ready: false,
        indexes: expected.map((name) => ({ name, state: 'MISSING' })),
        checkedAt: new Date(now).toISOString(),
      };
      this.cache = { snapshot, at: now };
      return snapshot;
    }

    const byName = new Map(states.map((s) => [s.name, s]));
    const indexes: VectorIndexState[] = expected.map((name) => {
      const found = byName.get(name);
      return found ? { name, state: found.state } : { name, state: 'MISSING' };
    });
    const ready = indexes.every((i) => i.state === 'ONLINE');
    const snapshot: VectorIndexReadinessSnapshot = {
      ready,
      indexes,
      checkedAt: new Date(now).toISOString(),
    };
    this.cache = { snapshot, at: now };
    return snapshot;
  }

  /** Invalidates the cache so the next `snapshot()` re-queries Neo4j. */
  invalidate(): void {
    this.cache = null;
  }
}
