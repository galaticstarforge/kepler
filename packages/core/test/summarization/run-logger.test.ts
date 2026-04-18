import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FilesystemDocumentStore } from '../../src/storage/filesystem-document-store.js';
import { RunLogger } from '../../src/summarization/run-logger.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-run-logger-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('RunLogger', () => {
  it('flush writes buffered entries to the document store', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const logger = new RunLogger(store, 'test-run-id');

    logger.logCall('get_node', { symbolId: 'repo:file#name' }, { name: 'name' });
    logger.logCall('write_summary', { tier: 'canonical' }, { validation: 'validated' });
    await logger.flush();

    const doc = await store.get('summarization/_runs/test-run-id.jsonl');
    expect(doc).not.toBeNull();
    const text = doc!.content.toString('utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as { tool: string; input: unknown };
    expect(first.tool).toBe('get_node');

    const second = JSON.parse(lines[1]!) as { tool: string };
    expect(second.tool).toBe('write_summary');
  });

  it('flush is idempotent when buffer is empty', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const logger = new RunLogger(store, 'empty-run');
    await expect(logger.flush()).resolves.not.toThrow();
    const doc = await store.get('summarization/_runs/empty-run.jsonl');
    expect(doc).toBeNull();
  });

  it('appends to existing content on repeated flushes', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const logger = new RunLogger(store, 'append-run');

    logger.logCall('tool_a', {}, {});
    await logger.flush();
    logger.logCall('tool_b', {}, {});
    await logger.flush();

    const doc = await store.get('summarization/_runs/append-run.jsonl');
    const text = doc!.content.toString('utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});
