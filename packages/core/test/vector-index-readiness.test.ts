import { describe, expect, it } from 'vitest';

import type { GraphClient } from '../src/graph/graph-client.js';
import { VECTOR_INDEX_NAMES } from '../src/graph/schema.js';
import { VectorIndexReadiness } from '../src/semantic/vector-index-readiness.js';

class FakeGraph {
  public calls = 0;
  constructor(private readonly state: Array<{ name: string; state: string; type: string }> | Error) {}
  async indexStates(): Promise<Array<{ name: string; state: string; type: string }>> {
    this.calls++;
    if (this.state instanceof Error) throw this.state;
    return this.state;
  }
}

function graphWith(state: Array<{ name: string; state: string; type: string }> | Error): { fake: FakeGraph; client: GraphClient } {
  const fake = new FakeGraph(state);
  return { fake, client: fake as unknown as GraphClient };
}

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe('VectorIndexReadiness', () => {
  it('reports ready when both indexes are ONLINE', async () => {
    const { client } = graphWith([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph: client, logger: silentLogger() });
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.indexes).toHaveLength(2);
    expect(snapshot.indexes.every((i) => i.state === 'ONLINE')).toBe(true);
  });

  it('reports not-ready when an index is still populating', async () => {
    const { client } = graphWith([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'POPULATING', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph: client, logger: silentLogger() });
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(false);
    const community = snapshot.indexes.find((i) => i.name === VECTOR_INDEX_NAMES.communitySummary);
    expect(community?.state).toBe('POPULATING');
  });

  it('reports not-ready with MISSING state when an index is absent', async () => {
    const { client } = graphWith([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph: client, logger: silentLogger() });
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(false);
    const community = snapshot.indexes.find((i) => i.name === VECTOR_INDEX_NAMES.communitySummary);
    expect(community?.state).toBe('MISSING');
  });

  it('degrades gracefully when the probe query fails', async () => {
    const { client } = graphWith(new Error('neo4j down'));
    const readiness = new VectorIndexReadiness({ graph: client, logger: silentLogger() });
    const snapshot = await readiness.snapshot();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.indexes.every((i) => i.state === 'MISSING')).toBe(true);
  });

  it('caches snapshots within the TTL window', async () => {
    const { fake, client } = graphWith([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    let now = 1000;
    const readiness = new VectorIndexReadiness({
      graph: client,
      logger: silentLogger(),
      cacheTtlMs: 100,
      now: () => now,
    });

    await readiness.snapshot();
    await readiness.snapshot();
    expect(fake.calls).toBe(1);

    now += 200;
    await readiness.snapshot();
    expect(fake.calls).toBe(2);
  });

  it('bypasses the cache when force=true', async () => {
    const { fake, client } = graphWith([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph: client, logger: silentLogger() });
    await readiness.snapshot();
    await readiness.snapshot({ force: true });
    expect(fake.calls).toBe(2);
  });
});
