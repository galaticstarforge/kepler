import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DocumentMetadata } from '@keplerforge/shared';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';


import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

let tmpDir: string;
let store: FilesystemDocumentStore;

const meta: DocumentMetadata = {
  contentType: 'text/markdown',
  contentLength: 0,
  lastModified: new Date(),
  custom: { author: 'test' },
};

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-fs-test-'));
  store = new FilesystemDocumentStore(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('FilesystemDocumentStore', () => {
  it('returns null for a missing document', async () => {
    const result = await store.get('nonexistent.md');
    expect(result).toBeNull();
  });

  it('puts and gets a document', async () => {
    const content = Buffer.from('# Hello\n\nWorld');
    await store.put('hello.md', content, { ...meta, contentLength: content.length });

    const result = await store.get('hello.md');
    expect(result).not.toBeNull();
    expect(result!.content.toString('utf8')).toBe('# Hello\n\nWorld');
    expect(result!.metadata.contentType).toBe('text/markdown');
    expect(result!.metadata.custom['author']).toBe('test');
  });

  it('creates nested directories on put', async () => {
    const content = Buffer.from('nested');
    await store.put('services/auth/README.md', content, meta);

    const result = await store.get('services/auth/README.md');
    expect(result).not.toBeNull();
    expect(result!.content.toString('utf8')).toBe('nested');
  });

  it('deletes a document', async () => {
    const content = Buffer.from('to-delete');
    await store.put('delete-me.md', content, meta);

    await store.delete('delete-me.md');
    const result = await store.get('delete-me.md');
    expect(result).toBeNull();
  });

  it('delete on nonexistent path does not throw', async () => {
    await expect(store.delete('nope.md')).resolves.toBeUndefined();
  });

  it('head returns metadata without body', async () => {
    const content = Buffer.from('head test');
    await store.put('head.md', content, { ...meta, contentLength: content.length });

    const head = await store.head('head.md');
    expect(head).not.toBeNull();
    expect(head!.path).toBe('head.md');
    expect(head!.metadata.contentLength).toBeGreaterThan(0);
  });

  it('head returns null for missing document', async () => {
    const head = await store.head('missing.md');
    expect(head).toBeNull();
  });

  it('lists documents under a prefix', async () => {
    await store.put('platform/arch.md', Buffer.from('a'), meta);
    await store.put('platform/security.md', Buffer.from('b'), meta);
    await store.put('services/auth.md', Buffer.from('c'), meta);

    const items: string[] = [];
    for await (const head of store.list('platform')) {
      items.push(head.path);
    }

    expect(items).toHaveLength(2);
    expect(items).toContain('platform/arch.md');
    expect(items).toContain('platform/security.md');
  });

  it('lists empty result for nonexistent prefix', async () => {
    const items: string[] = [];
    for await (const head of store.list('nope')) {
      items.push(head.path);
    }
    expect(items).toHaveLength(0);
  });

  it('overwrites document on second put', async () => {
    await store.put('overwrite.md', Buffer.from('v1'), meta);
    await store.put('overwrite.md', Buffer.from('v2'), meta);

    const result = await store.get('overwrite.md');
    expect(result!.content.toString('utf8')).toBe('v2');
  });
});
