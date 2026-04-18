import { describe, expect, it } from 'vitest';

import type { GraphClient } from '../src/graph/graph-client.js';
import { VECTOR_INDEX_NAMES } from '../src/graph/schema.js';
import { graphSemanticSearch } from '../src/mcp/handlers/graph-semantic-search.js';
import { isServiceUnavailable } from '../src/mcp/handlers/service-status.js';
import { McpRouter } from '../src/mcp/mcp-router.js';
import type { HandlerContext } from '../src/mcp/types.js';
import { VectorIndexReadiness } from '../src/semantic/vector-index-readiness.js';

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function fakeGraphWithIndexStates(
  indexStates: Array<{ name: string; state: string; type: string }>,
  readRows: Array<Record<string, unknown>> = [],
): GraphClient {
  return {
    async indexStates() {
      return indexStates;
    },
    async runRead<T>(_cypher: string, _params: Record<string, unknown>, map: (r: unknown) => T) {
      return readRows.map((row) =>
        map({
          get: (key: string) => row[key],
          toObject: () => row,
        }),
      );
    },
  } as unknown as GraphClient;
}

function makeCtx(overrides: Partial<HandlerContext>): HandlerContext {
  return {
    logger: silentLogger(),
    ...overrides,
  } as unknown as HandlerContext;
}

describe('graph.semanticSearch handler', () => {
  it('refuses with service-unavailable when vector indexes are not ONLINE', async () => {
    const graph = fakeGraphWithIndexStates([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'POPULATING', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph, logger: silentLogger() });

    const response = await graphSemanticSearch(
      { query: 'payments', queryVector: [0.1, 0.2] },
      makeCtx({ graph, vectorIndexReadiness: readiness }),
    );

    expect(isServiceUnavailable(response)).toBe(true);
    expect(response.isError).toBe(true);
  });

  it('returns an empty hit set when no queryVector is provided', async () => {
    const graph = fakeGraphWithIndexStates([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph, logger: silentLogger() });

    const response = await graphSemanticSearch(
      { query: 'payments' },
      makeCtx({ graph, vectorIndexReadiness: readiness }),
    );

    expect(response.isError).toBeUndefined();
    const block = response.content.find((c) => c.type === 'structured');
    expect(block).toBeDefined();
    expect((block!.data as { hits: unknown[] }).hits).toEqual([]);
  });

  it('invokes the vector query and returns structured hits when ready', async () => {
    const graph = fakeGraphWithIndexStates(
      [
        { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
        { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
      ],
      [
        {
          summary: { properties: { symbolFqn: 'repo:path#foo', purpose: 'handles payments' } },
          score: 0.91,
        },
      ],
    );
    const readiness = new VectorIndexReadiness({ graph, logger: silentLogger() });

    const response = await graphSemanticSearch(
      { queryVector: [0.1, 0.2, 0.3], topK: 3 },
      makeCtx({ graph, vectorIndexReadiness: readiness }),
    );

    expect(response.isError).toBeUndefined();
    const block = response.content.find((c) => c.type === 'structured');
    const data = block!.data as { hits: Array<{ score: number; summary: Record<string, unknown> }>; kind: string };
    expect(data.kind).toBe('Symbol');
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]!.score).toBeCloseTo(0.91);
    expect(data.hits[0]!.summary).toMatchObject({ symbolFqn: 'repo:path#foo' });
  });
});

describe('McpRouter + service-unavailable propagation', () => {
  it('sets httpStatus=503 when a handler flags service-unavailable', async () => {
    const graph = fakeGraphWithIndexStates([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'MISSING', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'MISSING', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph, logger: silentLogger() });

    const ctx = makeCtx({ graph, vectorIndexReadiness: readiness });
    const router = new McpRouter(ctx);

    const response = await router.handleRequest({
      method: 'tools/call',
      params: {
        name: 'graph.semanticSearch',
        arguments: { query: 'payments', queryVector: [0.1] },
      },
      id: 7,
    });

    expect(response.httpStatus).toBe(503);
    expect(response.result).toBeDefined();
    expect(response.result!.isError).toBe(true);
  });

  it('exposes graph.semanticSearch via tools/list', async () => {
    const graph = fakeGraphWithIndexStates([
      { name: VECTOR_INDEX_NAMES.symbolSummary, state: 'ONLINE', type: 'VECTOR' },
      { name: VECTOR_INDEX_NAMES.communitySummary, state: 'ONLINE', type: 'VECTOR' },
    ]);
    const readiness = new VectorIndexReadiness({ graph, logger: silentLogger() });

    const ctx = makeCtx({ graph, vectorIndexReadiness: readiness });
    const router = new McpRouter(ctx);

    expect(router.listTools()).toContain('graph.semanticSearch');
  });
});
