import { describe, expect, it, vi } from 'vitest';

import type { GraphClient } from '../../src/graph/graph-client.js';
import { StructuralMetricsPass } from '../../src/indexer/analysis/structural-metrics.js';
import { SymbolContentHashPass } from '../../src/indexer/analysis/content-hash.js';
import type { PassContext } from '../../src/indexer/pass-runner.js';
import { createLogger } from '../../src/logger.js';

function makeCtx(overrides: Partial<PassContext> = {}): PassContext {
  return {
    repo: 'test-repo',
    workingDir: '/tmp/test-repo',
    graph: {} as GraphClient,
    config: undefined,
    logger: createLogger('test'),
    traceId: 'trace-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeGraph(overrides: Partial<GraphClient> = {}): GraphClient {
  return {
    runRead: vi.fn(),
    runWrite: vi.fn(),
    ...overrides,
  } as unknown as GraphClient;
}

describe('SymbolContentHashPass', () => {
  it('has the correct pass name', () => {
    const pass = new SymbolContentHashPass({ graph: makeGraph() });
    expect(pass.name).toBe('symbol-content-hash');
  });

  it('runFor delegates to run() with repo and workingDir', async () => {
    const pass = new SymbolContentHashPass({ graph: makeGraph() });
    const runSpy = vi.spyOn(pass, 'run').mockResolvedValue({
      symbolsHashed: 5,
      symbolsChanged: 2,
      filesSkipped: 0,
    });
    const ctx = makeCtx();
    await pass.runFor(ctx);
    expect(runSpy).toHaveBeenCalledWith({ repo: 'test-repo', workingDir: '/tmp/test-repo' });
  });
});

describe('StructuralMetricsPass', () => {
  it('has the correct pass name', () => {
    const pass = new StructuralMetricsPass({ graph: makeGraph() });
    expect(pass.name).toBe('structural-metrics');
  });

  it('runs on first invocation (no previous edge count)', async () => {
    const graph = makeGraph({
      runRead: vi.fn().mockImplementation((cypher: string) => {
        if (cypher.includes('_StructuralMetricsMeta')) return Promise.resolve([null]);
        return Promise.resolve([42]); // current edge count
      }),
      runWrite: vi.fn().mockResolvedValue([]),
    });
    const pass = new StructuralMetricsPass({ graph });
    const runSpy = vi.spyOn(pass, 'run').mockResolvedValue({
      projection: 'kepler-calls-test-repo',
      pageRankWritten: 10,
      betweennessWritten: 10,
      fanInWritten: 10,
      fanOutWritten: 10,
      communitiesDetected: 3,
      symbolsClassified: 10,
      reachableFromEntry: 8,
      unreachable: 2,
    });

    const ctx = makeCtx({ graph });
    const result = await pass.runFor(ctx);

    expect(runSpy).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ communitiesDetected: 3 });
  });

  it('skips when CALLS edge count delta is below threshold', async () => {
    const graph = makeGraph({
      runRead: vi.fn().mockImplementation((cypher: string) => {
        if (cypher.includes('_StructuralMetricsMeta')) return Promise.resolve([100]); // last count
        return Promise.resolve([102]); // current count — 2% delta
      }),
      runWrite: vi.fn().mockResolvedValue([]),
    });
    const pass = new StructuralMetricsPass({ graph });
    const runSpy = vi.spyOn(pass, 'run');

    const ctx = makeCtx({ graph });
    const result = await pass.runFor(ctx) as Record<string, unknown>;

    expect(runSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, reason: 'edge-delta-below-threshold' });
  });

  it('runs when edge count delta meets or exceeds threshold', async () => {
    const graph = makeGraph({
      runRead: vi.fn().mockImplementation((cypher: string) => {
        if (cypher.includes('_StructuralMetricsMeta')) return Promise.resolve([100]); // last
        return Promise.resolve([110]); // 10% delta
      }),
      runWrite: vi.fn().mockResolvedValue([]),
    });
    const pass = new StructuralMetricsPass({ graph });
    const runSpy = vi.spyOn(pass, 'run').mockResolvedValue({
      projection: 'p',
      pageRankWritten: 0,
      betweennessWritten: 0,
      fanInWritten: 0,
      fanOutWritten: 0,
      communitiesDetected: 1,
      symbolsClassified: 0,
      reachableFromEntry: 0,
      unreachable: 0,
    });

    const ctx = makeCtx({ graph });
    await pass.runFor(ctx);

    expect(runSpy).toHaveBeenCalledOnce();
    // edge count should be persisted
    expect(graph.runWrite).toHaveBeenCalledWith(
      expect.stringContaining('_StructuralMetricsMeta'),
      expect.objectContaining({ repo: 'test-repo', count: 110 }),
    );
  });

  it('respects custom edgeDeltaThreshold from pass config', async () => {
    const graph = makeGraph({
      runRead: vi.fn().mockImplementation((cypher: string) => {
        if (cypher.includes('_StructuralMetricsMeta')) return Promise.resolve([100]);
        return Promise.resolve([108]); // 8% delta
      }),
      runWrite: vi.fn().mockResolvedValue([]),
    });
    const pass = new StructuralMetricsPass({ graph });
    const runSpy = vi.spyOn(pass, 'run').mockResolvedValue({
      projection: 'p',
      pageRankWritten: 0,
      betweennessWritten: 0,
      fanInWritten: 0,
      fanOutWritten: 0,
      communitiesDetected: 1,
      symbolsClassified: 0,
      reachableFromEntry: 0,
      unreachable: 0,
    });

    // threshold set to 10% — 8% delta should skip
    const ctx = makeCtx({ graph, config: { edgeDeltaThreshold: 0.10 } });
    const result = await pass.runFor(ctx) as Record<string, unknown>;
    expect(runSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  it('propagates GDS errors without swallowing them', async () => {
    const graph = makeGraph({
      runRead: vi.fn().mockImplementation((cypher: string) => {
        if (cypher.includes('_StructuralMetricsMeta')) return Promise.resolve([null]);
        return Promise.resolve([5]);
      }),
      runWrite: vi.fn().mockResolvedValue([]),
    });
    const pass = new StructuralMetricsPass({ graph });
    vi.spyOn(pass, 'run').mockRejectedValue(new Error('GDS heap exceeded'));

    const ctx = makeCtx({ graph });
    await expect(pass.runFor(ctx)).rejects.toThrow('GDS heap exceeded');
  });
});
