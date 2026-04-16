import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TemplateManager } from '../src/docs/template-manager.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

let tmpDir: string;
let store: FilesystemDocumentStore;
let templates: TemplateManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-tpl-test-'));
  store = new FilesystemDocumentStore(tmpDir);
  templates = new TemplateManager(store);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const meta = {
  contentType: 'text/markdown' as const,
  contentLength: 0,
  lastModified: new Date(),
  custom: {},
};

describe('TemplateManager', () => {
  it('lists templates from the store', async () => {
    await store.put('_meta/templates/adr.md', Buffer.from('# ADR'), meta);
    await store.put('_meta/templates/runbook.md', Buffer.from('# Runbook'), meta);

    const list = await templates.listTemplates();
    expect(list).toHaveLength(2);
    const names = list.map((t) => t.name);
    expect(names).toContain('adr');
    expect(names).toContain('runbook');
  });

  it('returns empty list when no templates exist', async () => {
    const list = await templates.listTemplates();
    expect(list).toHaveLength(0);
  });

  it('gets a template by name', async () => {
    await store.put('_meta/templates/guide.md', Buffer.from('# Guide: {{Title}}'), meta);

    const content = await templates.getTemplate('guide');
    expect(content).toBe('# Guide: {{Title}}');
  });

  it('returns null for missing template', async () => {
    const content = await templates.getTemplate('nonexistent');
    expect(content).toBeNull();
  });

  it('applies template with variable substitution', async () => {
    const template = `---
title: "{{NNNN}} - {{Title}}"
type: adr
author: {{author}}
---

# {{NNNN}} - {{Title}}
`;
    await store.put('_meta/templates/adr.md', Buffer.from(template), meta);

    const result = await templates.applyTemplate('adr', {
      NNNN: '0001',
      Title: 'Use PostgreSQL',
      author: 'human',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('0001 - Use PostgreSQL');
    expect(result).toContain('author: human');
    expect(result).not.toContain('{{');
  });

  it('returns null when applying a missing template', async () => {
    const result = await templates.applyTemplate('missing', { Title: 'x' });
    expect(result).toBeNull();
  });

  it('leaves unmatched placeholders as-is', async () => {
    await store.put('_meta/templates/test.md', Buffer.from('{{known}} and {{unknown}}'), meta);

    const result = await templates.applyTemplate('test', { known: 'replaced' });
    expect(result).toContain('replaced');
    expect(result).toContain('{{unknown}}');
  });

  it('ensures default templates on first run', async () => {
    await templates.ensureDefaultTemplates();

    const list = await templates.listTemplates();
    expect(list.length).toBeGreaterThan(0);
    const names = list.map((t) => t.name);
    expect(names).toContain('adr');
  });

  it('does not overwrite existing templates', async () => {
    await store.put('_meta/templates/adr.md', Buffer.from('custom adr'), meta);

    await templates.ensureDefaultTemplates();

    const content = await templates.getTemplate('adr');
    expect(content).toBe('custom adr');
  });
});
