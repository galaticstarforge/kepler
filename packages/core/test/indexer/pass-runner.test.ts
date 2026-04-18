import { describe, expect, it } from 'vitest';

import type { GraphClient } from '../../src/graph/graph-client.js';
import {
  NoopPassRunHistoryStore,
  type Pass,
  type PassContext,
  type PassRunRecord,
  PassRunner,
  type PassRunnerConfig,
} from '../../src/indexer/index.js';
import type { PassRunHistoryStore } from '../../src/indexer/pass-run-history-store.js';

function stubGraph(): GraphClient {
  return {} as unknown as GraphClient;
}

function defaultConfig(overrides: Partial<PassRunnerConfig> = {}): PassRunnerConfig {
  return {
    passTimeoutSeconds: 60,
    passFailurePolicy: 'continue',
    passes: {},
    ...overrides,
  };
}

class RecordingHistoryStore implements PassRunHistoryStore {
  public readonly records: PassRunRecord[] = [];
  async append(record: PassRunRecord): Promise<void> {
    this.records.push(record);
  }
  async list(repo: string, limit = 100): Promise<PassRunRecord[]> {
    return this.records
      .filter((r) => r.repo === repo)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }
}

function makePass(
  name: string,
  runFor: (ctx: PassContext) => Promise<Record<string, unknown> | void>,
): Pass {
  return { name, runFor };
}

describe('PassRunner', () => {
  const input = { repo: 'demo', workingDir: '/tmp/demo' };

  it('runs two passes with a dependency in declared order', async () => {
    const order: string[] = [];
    const history = new RecordingHistoryStore();
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig(),
      historyStore: history,
    });

    runner.register(
      makePass('b', async () => {
        order.push('b');
      }),
      { dependsOn: ['a'] },
    );
    runner.register(
      makePass('a', async () => {
        order.push('a');
      }),
    );

    const records = await runner.runAll(input);

    expect(order).toEqual(['a', 'b']);
    const [first, second] = records;
    expect(first?.pass).toBe('a');
    expect(second?.pass).toBe('b');
    expect(records.every((r) => r.status === 'success')).toBe(true);
    expect(history.records).toHaveLength(2);
  });

  it('records timeout status when a pass exceeds its timeout', async () => {
    const history = new RecordingHistoryStore();
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig(),
      historyStore: history,
    });

    runner.register(
      makePass('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }),
      { timeoutSeconds: 0.05 },
    );

    const [record] = await runner.runAll(input);

    expect(record?.status).toBe('timeout');
    expect(record?.error).toMatch(/timeout/i);
    expect(history.records[0]?.status).toBe('timeout');
  });

  it('aborts the pass signal after the timeout fires', async () => {
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig(),
    });

    let capturedSignal: AbortSignal | null = null;
    runner.register(
      makePass('cooperative', async (ctx) => {
        capturedSignal = ctx.signal;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }),
      { timeoutSeconds: 0.05 },
    );

    await runner.runAll(input);
    expect(capturedSignal?.aborted).toBe(true);
  });

it('continues running subsequent passes after a failure under continue policy', async () => {
    const seen: string[] = [];
    const history = new RecordingHistoryStore();
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig({ passFailurePolicy: 'continue' }),
      historyStore: history,
    });

    runner.register(
      makePass('boom', async () => {
        seen.push('boom');
        throw new Error('nope');
      }),
    );
    runner.register(
      makePass('later', async () => {
        seen.push('later');
        return { wrote: 1 };
      }),
    );

    const records = await runner.runAll(input);

    expect(seen).toEqual(['boom', 'later']);
    expect(records.map((r) => r.status)).toEqual(['error', 'success']);
    expect(records[0]?.error).toBe('nope');
    expect(records[1]?.stats).toEqual({ wrote: 1 });
  });

  it('skips remaining passes when policy is abort', async () => {
    const seen: string[] = [];
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig({ passFailurePolicy: 'abort' }),
    });

    runner.register(
      makePass('first', async () => {
        seen.push('first');
        throw new Error('stop');
      }),
    );
    runner.register(
      makePass('second', async () => {
        seen.push('second');
      }),
    );

    const records = await runner.runAll(input);

    expect(seen).toEqual(['first']);
    expect(records.map((r) => r.status)).toEqual(['error', 'skipped']);
    expect(records[1]?.error).toMatch(/aborted after first/);
  });

  it('skips dependents when a dependency fails, but still runs independent siblings', async () => {
    const seen: string[] = [];
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig({ passFailurePolicy: 'continue' }),
    });

    runner.register(
      makePass('a', async () => {
        seen.push('a');
        throw new Error('a broke');
      }),
    );
    runner.register(
      makePass('b', async () => {
        seen.push('b');
      }),
      { dependsOn: ['a'] },
    );
    runner.register(
      makePass('c', async () => {
        seen.push('c');
      }),
    );

    const records = await runner.runAll(input);

    expect(seen).toEqual(['a', 'c']);
    const byName = Object.fromEntries(records.map((r) => [r.pass, r.status]));
    expect(byName).toEqual({ a: 'error', b: 'skipped', c: 'success' });
  });

  it('records skipped status when a pass is disabled in config', async () => {
    const ran: string[] = [];
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig({ passes: { skipme: { enabled: false } } }),
    });

    runner.register(
      makePass('skipme', async () => {
        ran.push('skipme');
      }),
    );
    runner.register(
      makePass('runme', async () => {
        ran.push('runme');
      }),
    );

    const records = await runner.runAll(input);

    expect(ran).toEqual(['runme']);
    const skipped = records.find((r) => r.pass === 'skipme');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.error).toMatch(/disabled/);
  });

  it('passes per-pass config into the pass context', async () => {
    let captured: unknown = null;
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig({
        passes: { typed: { enabled: true, config: { knob: 42 } } },
      }),
    });

    runner.register(
      makePass('typed', async (ctx) => {
        captured = ctx.config;
      }),
    );

    await runner.runAll(input);

    expect(captured).toEqual({ knob: 42 });
  });

  it('rejects registering the same pass twice', () => {
    const runner = new PassRunner({ graph: stubGraph(), config: defaultConfig() });
    runner.register(makePass('x', async () => {}));
    expect(() => runner.register(makePass('x', async () => {}))).toThrow(/already registered/);
  });

  it('throws when a pass depends on an unknown pass', async () => {
    const runner = new PassRunner({ graph: stubGraph(), config: defaultConfig() });
    runner.register(makePass('a', async () => {}), { dependsOn: ['missing'] });
    await expect(runner.runAll(input)).rejects.toThrow(/unknown pass/);
  });

  it('throws when registered passes form a cycle', async () => {
    const runner = new PassRunner({ graph: stubGraph(), config: defaultConfig() });
    runner.register(makePass('a', async () => {}), { dependsOn: ['b'] });
    runner.register(makePass('b', async () => {}), { dependsOn: ['a'] });
    await expect(runner.runAll(input)).rejects.toThrow(/cycle/);
  });

  it('reuses the provided traceId across every pass in a single run', async () => {
    const traceIds: string[] = [];
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig(),
    });

    runner.register(
      makePass('one', async (ctx) => {
        traceIds.push(ctx.traceId);
      }),
    );
    runner.register(
      makePass('two', async (ctx) => {
        traceIds.push(ctx.traceId);
      }),
    );

    const records = await runner.runAll({ ...input, traceId: 'trace-42' });

    expect(traceIds).toEqual(['trace-42', 'trace-42']);
    expect(records.every((r) => r.traceId === 'trace-42')).toBe(true);
  });

  it('uses a NoopPassRunHistoryStore by default', async () => {
    const noop = new NoopPassRunHistoryStore();
    const runner = new PassRunner({
      graph: stubGraph(),
      config: defaultConfig(),
      historyStore: noop,
    });
    runner.register(makePass('x', async () => {}));
    const records = await runner.runAll(input);
    expect(records).toHaveLength(1);
    expect(await noop.list('demo')).toEqual([]);
  });
});
