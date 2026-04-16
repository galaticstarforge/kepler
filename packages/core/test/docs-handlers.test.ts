import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TemplateManager } from '../src/docs/template-manager.js';
import { McpRouter } from '../src/mcp/mcp-router.js';
import type { HandlerContext } from '../src/mcp/types.js';
import { NoopSemanticIndex } from '../src/semantic/noop-semantic-index.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

let tmpDir: string;
let router: McpRouter;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-mcp-test-'));
  const store = new FilesystemDocumentStore(tmpDir);
  const index = new NoopSemanticIndex();
  const templates = new TemplateManager(store);

  const ctx: HandlerContext = {
    store,
    index,
    templates,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  router = new McpRouter(ctx);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const VALID_DOC = `---
title: Test Doc
type: guide
status: draft
author: human
created: 2026-01-01
updated: 2026-01-01
---

# Test Doc

Some content here.
`;

describe('docs.create', () => {
  it('creates a new document', async () => {
    const result = await router.handleToolCall('docs.create', {
      path: 'guides/test.md',
      content: VALID_DOC,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('Created');
  });

  it('rejects when document already exists', async () => {
    await router.handleToolCall('docs.create', {
      path: 'existing.md',
      content: VALID_DOC,
    });

    const result = await router.handleToolCall('docs.create', {
      path: 'existing.md',
      content: VALID_DOC,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already exists');
  });

  it('returns error for missing path', async () => {
    const result = await router.handleToolCall('docs.create', { content: 'x' });
    expect(result.isError).toBe(true);
  });
});

describe('docs.read', () => {
  it('reads a created document', async () => {
    await router.handleToolCall('docs.create', {
      path: 'read-test.md',
      content: VALID_DOC,
    });

    const result = await router.handleToolCall('docs.read', { path: 'read-test.md' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('# Test Doc');
  });

  it('returns error for missing document', async () => {
    const result = await router.handleToolCall('docs.read', { path: 'missing.md' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not found');
  });
});

describe('docs.update', () => {
  it('updates an existing document', async () => {
    await router.handleToolCall('docs.create', {
      path: 'update-test.md',
      content: VALID_DOC,
    });

    const updated = VALID_DOC.replace('Some content here.', 'Updated content.');
    const result = await router.handleToolCall('docs.update', {
      path: 'update-test.md',
      content: updated,
    });

    expect(result.isError).toBeFalsy();

    const read = await router.handleToolCall('docs.read', { path: 'update-test.md' });
    expect(read.content[0]!.text).toContain('Updated content.');
  });

  it('returns error for nonexistent document', async () => {
    const result = await router.handleToolCall('docs.update', {
      path: 'nonexistent.md',
      content: VALID_DOC,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not found');
  });
});

describe('docs.delete', () => {
  it('deletes a document', async () => {
    await router.handleToolCall('docs.create', { path: 'delete-me.md', content: VALID_DOC });
    const result = await router.handleToolCall('docs.delete', { path: 'delete-me.md' });

    expect(result.isError).toBeFalsy();

    const read = await router.handleToolCall('docs.read', { path: 'delete-me.md' });
    expect(read.isError).toBe(true);
  });
});

describe('docs.list', () => {
  it('lists documents under a prefix', async () => {
    await router.handleToolCall('docs.create', { path: 'guides/a.md', content: VALID_DOC });
    await router.handleToolCall('docs.create', { path: 'guides/b.md', content: VALID_DOC });
    await router.handleToolCall('docs.create', { path: 'services/c.md', content: VALID_DOC });

    const result = await router.handleToolCall('docs.list', { prefix: 'guides' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('2 document(s)');
  });
});

describe('docs.search', () => {
  it('returns empty results with NoopSemanticIndex', async () => {
    const result = await router.handleToolCall('docs.search', { query: 'anything' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('No documents matched');
  });
});

describe('docs.propose', () => {
  it('creates document under .claude/proposals/', async () => {
    const result = await router.handleToolCall('docs.propose', {
      name: 'new-idea',
      content: VALID_DOC,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('.claude/proposals/');

    const read = await router.handleToolCall('docs.read', {
      path: '.claude/proposals/new-idea.md',
    });
    expect(read.isError).toBeFalsy();
  });
});

describe('docs.listTemplates', () => {
  it('returns empty when no templates installed', async () => {
    const result = await router.handleToolCall('docs.listTemplates', {});
    expect(result.isError).toBeFalsy();
  });
});

describe('docs.applyTemplate', () => {
  it('creates document from template', async () => {
    // Manually install a template first.
    const store = new FilesystemDocumentStore(tmpDir);
    await store.put(
      '_meta/templates/test.md',
      Buffer.from('# {{Title}}\n\nBy {{author}}'),
      { contentType: 'text/markdown', contentLength: 0, lastModified: new Date(), custom: {} },
    );

    const result = await router.handleToolCall('docs.applyTemplate', {
      template: 'test',
      path: 'output.md',
      variables: { Title: 'Hello', author: 'Test User' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('Created document');

    const read = await router.handleToolCall('docs.read', { path: 'output.md' });
    expect(read.content[0]!.text).toContain('# Hello');
    expect(read.content[0]!.text).toContain('By Test User');
  });

  it('returns error for missing template', async () => {
    const result = await router.handleToolCall('docs.applyTemplate', {
      template: 'nonexistent',
      path: 'output.md',
    });
    expect(result.isError).toBe(true);
  });
});

describe('unknown tool', () => {
  it('returns error for unregistered tool', async () => {
    const result = await router.handleToolCall('unknown.tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown tool');
  });
});
