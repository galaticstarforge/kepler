import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmClient } from '../../src/enrichment/llm/llm-client.js';
import type { GraphClient } from '../../src/graph/graph-client.js';
import { FilesystemDocumentStore } from '../../src/storage/filesystem-document-store.js';
import { SummarizationAgent } from '../../src/summarization/agent.js';
import { NoopSourceAccess } from '../../src/summarization/source-access.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-agent-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function stubLlm(response: string): LlmClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response }),
    embed: vi.fn().mockResolvedValue({ vector: new Float32Array(4), model: 'test' }),
  };
}

function stubGraph(overrides: Partial<GraphClient> = {}): GraphClient {
  return {
    runRead: vi.fn().mockResolvedValue([]),
    runWrite: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue(),
    connect: vi.fn().mockResolvedValue(),
    close: vi.fn().mockResolvedValue(),
    applySchema: vi.fn().mockResolvedValue(),
    serverVersion: vi.fn().mockResolvedValue('5.14.0'),
    indexStates: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as GraphClient;
}

describe('SummarizationAgent', () => {
  it('trigger() returns a runId and starts a run', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    const graph = stubGraph();
    const llm = stubLlm(
      JSON.stringify({ purpose: 'does something', semanticTags: ['util'] }),
    );

    const agent = new SummarizationAgent({
      graph,
      store,
      sourceAccess: new NoopSourceAccess(),
      navigationLlm: llm,
      summaryLlm: llm,
    });

    const runId = agent.trigger({
      repo: 'my-repo',
      mode: 'incremental',
      embeddingModel: 'test-model',
      maxRunCostUSD: 0,
    });

    expect(runId).toBeTruthy();
    const status = agent.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.repo).toBe('my-repo');
    expect(['pending', 'running', 'complete']).toContain(status!.status);
  });

  it('getLastRun() returns undefined before any run completes', () => {
    const agent = new SummarizationAgent({
      graph: stubGraph(),
      store: new FilesystemDocumentStore(tmpDir),
      sourceAccess: new NoopSourceAccess(),
      navigationLlm: stubLlm('{}'),
      summaryLlm: stubLlm('{}'),
    });

    expect(agent.getLastRun()).toBeUndefined();
  });

  it('completes a run with no communities without error', async () => {
    const store = new FilesystemDocumentStore(tmpDir);
    // runRead returns [] for all queries; agent uses ?? defaults for coverage and
    // gets an empty pending list, so it completes with no work done.
    const graph = stubGraph();

    const agent = new SummarizationAgent({
      graph,
      store,
      sourceAccess: new NoopSourceAccess(),
      navigationLlm: stubLlm('{}'),
      summaryLlm: stubLlm('{}'),
    });

    const runId = agent.trigger({
      repo: 'empty-repo',
      mode: 'full',
      embeddingModel: 'test-model',
      maxRunCostUSD: 0,
    });

    // Wait for the async run to complete.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const status = agent.getRunStatus(runId);
        if (status && (status.status === 'complete' || status.status === 'failed')) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const final = agent.getRunStatus(runId);
    expect(final!.status).toBe('complete');
    expect(final!.stats?.communitiesProcessed).toBe(0);
  });

  it('gauges are initialized to zero', () => {
    const agent = new SummarizationAgent({
      graph: stubGraph(),
      store: new FilesystemDocumentStore(tmpDir),
      sourceAccess: new NoopSourceAccess(),
      navigationLlm: stubLlm('{}'),
      summaryLlm: stubLlm('{}'),
    });
    expect(agent.gauges.canonicalPct).toBe(0);
    expect(agent.gauges.staleCount).toBe(0);
    expect(agent.gauges.lastRunCostUSD).toBe(0);
  });
});
