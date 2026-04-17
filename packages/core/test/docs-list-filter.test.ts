import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TemplateManager } from '../src/docs/template-manager.js';
import { ConceptExtractor } from '../src/enrichment/concept-extractor.js';
import { ConceptStore } from '../src/enrichment/concept-store.js';
import { EnrichmentRunner } from '../src/enrichment/enrichment-runner.js';
import { NoopLlmClient } from '../src/enrichment/llm/noop-llm-client.js';
import type { GraphClient } from '../src/graph/graph-client.js';
import { McpRouter } from '../src/mcp/mcp-router.js';
import type { HandlerContext } from '../src/mcp/types.js';
import { NoopSemanticIndex } from '../src/semantic/noop-semantic-index.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

interface ListResult {
  content: Array<{ type: string; data?: unknown; text?: string }>;
}

const VALID_DOC = `---
title: T
type: guide
status: draft
author: a
created: 2026-01-01
updated: 2026-01-01
---
# T

body
`;

let tmpDir: string;
let router: McpRouter;
let conceptStore: ConceptStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-list-filter-'));
  const store = new FilesystemDocumentStore(tmpDir);
  const index = new NoopSemanticIndex();
  const templates = new TemplateManager(store);
  conceptStore = new ConceptStore(store);
  const llm = new NoopLlmClient();
  const extractor = new ConceptExtractor(llm);
  const enrichmentRunner = new EnrichmentRunner({
    store,
    conceptStore,
    extractor,
    llm,
    config: {
      enabled: false,
      provider: 'none',
      model: 'stub',
      embeddingModel: 'stub',
      similarityThreshold: 0.88,
      minDocChars: 400,
    },
  });

  const ctx: HandlerContext = {
    store,
    index,
    graph: {} as unknown as GraphClient,
    templates,
    conceptStore,
    enrichmentRunner,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
  router = new McpRouter(ctx);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('docs.list filters concepts/', () => {
  it('omits concept-prefixed entries from docs.list', async () => {
    await router.handleToolCall('docs.create', { path: 'guides/a.md', content: VALID_DOC });
    await conceptStore.put({
      id: 'x',
      name: 'X',
      description: '',
      embeddingB64: '',
      embeddingModel: 'test',
      mentions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = (await router.handleToolCall('docs.list', {})) as unknown as ListResult;
    const structured = result.content.find((c) => c.type === 'structured');
    const items = (structured?.data ?? []) as Array<{ path: string }>;
    expect(items.some((i) => i.path.startsWith('concepts/'))).toBe(false);
  });

  it('returns concept entries when caller explicitly lists under concepts/', async () => {
    await conceptStore.put({
      id: 'x',
      name: 'X',
      description: '',
      embeddingB64: '',
      embeddingModel: 'test',
      mentions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = (await router.handleToolCall('docs.list', {
      prefix: 'concepts/',
    })) as unknown as ListResult;
    const structured = result.content.find((c) => c.type === 'structured');
    const items = (structured?.data ?? []) as Array<{ path: string }>;
    expect(items.length).toBeGreaterThan(0);
  });
});
