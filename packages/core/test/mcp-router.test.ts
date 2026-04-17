import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TemplateManager } from '../src/docs/template-manager.js';
import type { GraphClient } from '../src/graph/graph-client.js';
import { McpRouter } from '../src/mcp/mcp-router.js';
import type { HandlerContext } from '../src/mcp/types.js';
import { NoopSemanticIndex } from '../src/semantic/noop-semantic-index.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

let tmpDir: string;
let router: McpRouter;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-router-test-'));
  const store = new FilesystemDocumentStore(tmpDir);
  const ctx = {
    store,
    index: new NoopSemanticIndex(),
    graph: {} as unknown as GraphClient,
    templates: new TemplateManager(store),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as HandlerContext;
  router = new McpRouter(ctx);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('McpRouter.handleRequest', () => {
  it('dispatches tools/call to tool handlers', async () => {
    const resp = await router.handleRequest({
      method: 'tools/call',
      params: {
        name: 'docs.create',
        arguments: { path: 'test.md', content: '# Test\n\nBody.' },
      },
      id: 1,
    });

    expect(resp.id).toBe(1);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
  });

  it('returns error for missing tool name in tools/call', async () => {
    const resp = await router.handleRequest({
      method: 'tools/call',
      params: {},
      id: 2,
    });

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32_602);
  });

  it('handles tools/list', async () => {
    const resp = await router.handleRequest({
      method: 'tools/list',
      params: {},
      id: 3,
    });

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
  });

  it('returns error for unknown method', async () => {
    const resp = await router.handleRequest({
      method: 'unknown/method',
      params: {},
      id: 4,
    });

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32_601);
  });

  it('lists all registered tools', () => {
    const tools = router.listTools();
    expect(tools).toContain('docs.create');
    expect(tools).toContain('docs.read');
    expect(tools).toContain('docs.update');
    expect(tools).toContain('docs.delete');
    expect(tools).toContain('docs.list');
    expect(tools).toContain('docs.search');
    expect(tools).toContain('docs.propose');
    expect(tools).toContain('docs.listTemplates');
    expect(tools).toContain('docs.applyTemplate');
  });
});
