import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConceptExtractionConfig } from '../src/config.js';
import { ConceptExtractor } from '../src/enrichment/concept-extractor.js';
import { ConceptStore } from '../src/enrichment/concept-store.js';
import { EnrichmentRunner } from '../src/enrichment/enrichment-runner.js';
import type {
  CompletionResponse,
  EmbeddingResponse,
  LlmClient,
} from '../src/enrichment/llm/llm-client.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

const CONFIG: ConceptExtractionConfig = {
  enabled: true,
  provider: 'bedrock',
  model: 'stub',
  embeddingModel: 'stub',
  similarityThreshold: 0.88,
  minDocChars: 50,
};

const LONG_PARAGRAPH =
  'Our fraud detection pipeline looks for suspicious transaction patterns that deviate from expected customer behavior. '.repeat(
    20,
  );

function makeDoc(title: string, body: string): string {
  return `---\ntitle: ${title}\ntype: guide\nstatus: draft\nauthor: t\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# ${title}\n\n${body}\n`;
}

function stubLlm(conceptsPerCall: Array<{ name: string; description: string }[]>): LlmClient {
  const queue = [...conceptsPerCall];
  return {
    complete(): Promise<CompletionResponse> {
      const next = queue.shift() ?? [];
      return Promise.resolve({
        text: JSON.stringify({
          concepts: next.map((c) => ({
            name: c.name,
            description: c.description,
            confidence: 0.9,
          })),
        }),
      });
    },
    embed(req): Promise<EmbeddingResponse> {
      // Distinct vectors per name, so dedup-by-embedding stays predictable.
      const hash = Array.from(req.text).reduce((a, c) => a + c.charCodeAt(0), 0);
      const v = new Float32Array(8);
      for (let i = 0; i < v.length; i++) v[i] = (hash + i * 7) % 11;
      return Promise.resolve({ vector: v, model: 'stub' });
    },
  };
}

async function waitForStatus(
  conceptStore: ConceptStore,
  runId: string,
  want: 'completed' | 'failed',
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await conceptStore.getRun(runId);
    if (rec?.status === want) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached status ${want}`);
}

let tmpDir: string;
let store: FilesystemDocumentStore;
let conceptStore: ConceptStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-enrich-'));
  store = new FilesystemDocumentStore(tmpDir);
  conceptStore = new ConceptStore(store);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('EnrichmentRunner', () => {
  it('refuses to start when concept extraction is disabled', async () => {
    const llm = stubLlm([]);
    const runner = new EnrichmentRunner({
      store,
      conceptStore,
      extractor: new ConceptExtractor(llm),
      llm,
      config: { ...CONFIG, enabled: false, provider: 'none' },
    });

    await expect(runner.start()).rejects.toThrow(/disabled/i);
  });

  it('extracts concepts from docs and persists them', async () => {
    const llm = stubLlm([[{ name: 'Fraud Detection', description: 'finding fraud' }]]);
    const runner = new EnrichmentRunner({
      store,
      conceptStore,
      extractor: new ConceptExtractor(llm),
      llm,
      config: CONFIG,
    });

    const meta = {
      contentType: 'text/markdown',
      contentLength: 0,
      lastModified: new Date(),
      custom: {},
    };
    await store.put('a.md', Buffer.from(makeDoc('Fraud', LONG_PARAGRAPH)), meta);

    const rec = await runner.start();
    await waitForStatus(conceptStore, rec.runId, 'completed');

    const concept = await conceptStore.get('fraud-detection');
    expect(concept).not.toBeNull();
    expect(concept?.mentions[0]?.docPath).toBe('a.md');
    expect(concept?.mentions).toHaveLength(1);
  });

  it('dedups an identical concept across two docs via the slug fast path', async () => {
    const llm = stubLlm([
      [{ name: 'Fraud Detection', description: 'd' }],
      [{ name: 'Fraud Detection', description: 'd' }],
    ]);
    const runner = new EnrichmentRunner({
      store,
      conceptStore,
      extractor: new ConceptExtractor(llm),
      llm,
      config: CONFIG,
    });

    const meta = {
      contentType: 'text/markdown',
      contentLength: 0,
      lastModified: new Date(),
      custom: {},
    };
    await store.put('a.md', Buffer.from(makeDoc('A', LONG_PARAGRAPH)), meta);
    await store.put('b.md', Buffer.from(makeDoc('B', LONG_PARAGRAPH)), meta);

    const rec = await runner.start();
    await waitForStatus(conceptStore, rec.runId, 'completed');

    const concept = await conceptStore.get('fraud-detection');
    expect(concept?.mentions.map((m) => m.docPath).sort()).toEqual(['a.md', 'b.md']);

    const finalRec = await conceptStore.getRun(rec.runId);
    expect(finalRec?.stats.conceptsCreated).toBe(1);
  });

  it('skips docs under minDocChars', async () => {
    const llm = stubLlm([]);
    const runner = new EnrichmentRunner({
      store,
      conceptStore,
      extractor: new ConceptExtractor(llm),
      llm,
      config: { ...CONFIG, minDocChars: 10_000 },
    });

    await store.put('short.md', Buffer.from(makeDoc('S', 'tiny body')), {
      contentType: 'text/markdown',
      contentLength: 0,
      lastModified: new Date(),
      custom: {},
    });

    const rec = await runner.start();
    await waitForStatus(conceptStore, rec.runId, 'completed');

    const finalRec = await conceptStore.getRun(rec.runId);
    expect(finalRec?.stats.docsSkipped).toBe(1);
    expect(finalRec?.stats.docsScanned).toBe(0);
  });

  it('skips documents already under CONCEPTS_PREFIX', async () => {
    const llm = stubLlm([]);
    const runner = new EnrichmentRunner({
      store,
      conceptStore,
      extractor: new ConceptExtractor(llm),
      llm,
      config: CONFIG,
    });

    // Seed a concept file — the runner must not treat it as a source doc.
    await conceptStore.put({
      id: 'seed',
      name: 'Seed',
      description: 'seed',
      embeddingB64: '',
      embeddingModel: 'test',
      mentions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const rec = await runner.start();
    await waitForStatus(conceptStore, rec.runId, 'completed');

    const finalRec = await conceptStore.getRun(rec.runId);
    expect(finalRec?.stats.docsScanned).toBe(0);
  });
});
