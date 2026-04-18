import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GraphClient } from '../src/graph/graph-client.js';
import {
  EmbeddingModelRatchet,
  EMBEDDING_MODEL_META_PATH,
} from '../src/semantic/embedding-model-ratchet.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

class FakeGraph {
  public applied: string[][] = [];
  public version = '5.14.0';

  async serverVersion(): Promise<string> {
    return this.version;
  }
  async applySchema(statements: readonly string[]): Promise<void> {
    this.applied.push([...statements]);
  }
}

function mockGraph(overrides: Partial<FakeGraph> = {}): { fake: FakeGraph; client: GraphClient } {
  const fake = new FakeGraph();
  Object.assign(fake, overrides);
  return { fake, client: fake as unknown as GraphClient };
}

function silentLogger() {
  const log = { records: [] as Array<{ level: string; msg: string; ctx?: unknown }> };
  return {
    records: log.records,
    logger: {
      debug: () => {},
      info: (msg: string, ctx?: unknown) => log.records.push({ level: 'info', msg, ctx }),
      warn: (msg: string, ctx?: unknown) => log.records.push({ level: 'warn', msg, ctx }),
      error: (msg: string, ctx?: unknown) => log.records.push({ level: 'error', msg, ctx }),
    },
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-ratchet-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('EmbeddingModelRatchet', () => {
  it('installs vector indexes on first run and persists the model meta', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const { fake, client } = mockGraph();
    const { logger, records } = silentLogger();

    const ratchet = new EmbeddingModelRatchet({ graph: client, store, logger });
    const result = await ratchet.apply({ model: 'amazon.titan-embed-text-v2:0', dimensions: 1536 });

    expect(result.action).toBe('installed');
    expect(result.previous).toBeNull();
    expect(result.current.model).toBe('amazon.titan-embed-text-v2:0');
    expect(result.current.dimensions).toBe(1536);
    expect(result.neo4jVersion).toBe('5.14.0');

    // One apply batch for the two CREATE VECTOR INDEX statements.
    expect(fake.applied).toHaveLength(1);
    expect(fake.applied[0]!.every((s) => s.includes('CREATE VECTOR INDEX'))).toBe(true);
    expect(fake.applied[0]!.join('\n')).toContain('`vector.dimensions`: 1536');

    const stored = await store.get(EMBEDDING_MODEL_META_PATH);
    expect(stored).not.toBeNull();
    expect(stored!.content.toString('utf8')).toContain('amazon.titan-embed-text-v2:0');

    const infoLogs = records.filter((r) => r.level === 'info');
    expect(infoLogs.some((r) => r.msg === 'embedding model installed')).toBe(true);
  });

  it('leaves indexes in place when the configured model is unchanged', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const { fake, client } = mockGraph();
    const { logger, records } = silentLogger();

    const ratchet = new EmbeddingModelRatchet({ graph: client, store, logger });
    await ratchet.apply({ model: 'amazon.titan-embed-text-v2:0', dimensions: 1536 });
    fake.applied = []; // reset to observe the second call only.
    records.length = 0;

    const result = await ratchet.apply({ model: 'amazon.titan-embed-text-v2:0', dimensions: 1536 });

    expect(result.action).toBe('unchanged');
    // Idempotent re-apply still issues CREATE VECTOR INDEX IF NOT EXISTS once.
    expect(fake.applied).toHaveLength(1);
    expect(fake.applied[0]!.every((s) => s.includes('CREATE VECTOR INDEX'))).toBe(true);
    // No rotation log line.
    expect(records.some((r) => r.msg.includes('rotated'))).toBe(false);
  });

  it('drops and recreates vector indexes exactly once when the model rotates', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const { fake, client } = mockGraph();
    const { logger, records } = silentLogger();

    const ratchet = new EmbeddingModelRatchet({ graph: client, store, logger });
    await ratchet.apply({ model: 'amazon.titan-embed-text-v2:0', dimensions: 1536 });
    fake.applied = [];
    records.length = 0;

    const result = await ratchet.apply({
      model: 'openai.text-embedding-3-large',
      dimensions: 3072,
    });

    expect(result.action).toBe('rotated');
    expect(result.previous).not.toBeNull();
    expect(result.previous!.dimensions).toBe(1536);
    expect(result.current.dimensions).toBe(3072);

    // Exactly two apply batches: DROP, then CREATE.
    expect(fake.applied).toHaveLength(2);
    expect(fake.applied[0]!.every((s) => s.includes('DROP INDEX'))).toBe(true);
    expect(fake.applied[1]!.every((s) => s.includes('CREATE VECTOR INDEX'))).toBe(true);
    expect(fake.applied[1]!.join('\n')).toContain('`vector.dimensions`: 3072');

    const rotationLogs = records.filter((r) => r.msg.includes('rotated'));
    expect(rotationLogs).toHaveLength(1);
  });

  it('rejects older Neo4j versions with a clear error', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const { client } = mockGraph({ version: '5.10.0' });
    const { logger } = silentLogger();

    const ratchet = new EmbeddingModelRatchet({ graph: client, store, logger });
    await expect(
      ratchet.apply({ model: 'amazon.titan-embed-text-v2:0', dimensions: 1536 }),
    ).rejects.toThrow(/does not support native vector indexes/);
  });

  it('rejects invalid dimension counts', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const { client } = mockGraph();
    const { logger } = silentLogger();

    const ratchet = new EmbeddingModelRatchet({ graph: client, store, logger });
    await expect(
      ratchet.apply({ model: 'x', dimensions: 0 }),
    ).rejects.toThrow();
    await expect(
      ratchet.apply({ model: 'x', dimensions: -1 }),
    ).rejects.toThrow();
  });
});
