import { describe, it, expect } from 'vitest';

import { NoopSemanticIndex } from '../src/semantic/noop-semantic-index.js';

describe('NoopSemanticIndex', () => {
  it('upsert succeeds silently', async () => {
    const index = new NoopSemanticIndex();
    await expect(index.upsert({ path: 'x.md', content: 'x', metadata: {} })).resolves.toBeUndefined();
  });

  it('delete succeeds silently', async () => {
    const index = new NoopSemanticIndex();
    await expect(index.delete('x.md')).resolves.toBeUndefined();
  });

  it('search returns empty results', async () => {
    const index = new NoopSemanticIndex();
    const results = await index.search('anything');
    expect(results).toEqual([]);
  });

  it('status returns healthy with provider none', async () => {
    const index = new NoopSemanticIndex();
    const status = await index.status();
    expect(status.provider).toBe('none');
    expect(status.healthy).toBe(true);
    expect(status.documentCount).toBe(0);
    expect(status.lastSyncedAt).toBeNull();
  });
});
