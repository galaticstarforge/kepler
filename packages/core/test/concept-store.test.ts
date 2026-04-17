import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Concept, EnrichmentRunRecord } from '@kepler/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConceptStore } from '../src/enrichment/concept-store.js';
import { FilesystemDocumentStore } from '../src/storage/filesystem-document-store.js';

let tmpDir: string;
let conceptStore: ConceptStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-concept-store-'));
  conceptStore = new ConceptStore(new FilesystemDocumentStore(tmpDir));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function fakeConcept(id: string, name: string): Concept {
  const now = new Date().toISOString();
  return {
    id,
    name,
    description: `${name} description`,
    embeddingB64: '',
    embeddingModel: 'test',
    mentions: [{ docPath: 'a.md', confidence: 0.9, extractedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

describe('ConceptStore', () => {
  it('puts and gets a concept', async () => {
    const c = fakeConcept('fraud-detection', 'Fraud Detection');
    await conceptStore.put(c);
    const got = await conceptStore.get('fraud-detection');
    expect(got).toEqual(c);
  });

  it('returns null for missing concept', async () => {
    expect(await conceptStore.get('missing')).toBeNull();
  });

  it('lists concepts but not run records', async () => {
    await conceptStore.put(fakeConcept('a', 'A'));
    await conceptStore.put(fakeConcept('b', 'B'));
    await conceptStore.putRun({
      runId: 'r1',
      status: 'completed',
      startedAt: new Date().toISOString(),
      stats: {
        docsScanned: 0,
        docsSkipped: 0,
        candidatesExtracted: 0,
        conceptsCreated: 0,
        conceptsUpdated: 0,
        errors: [],
      },
    });

    const ids: string[] = [];
    for await (const c of conceptStore.list()) ids.push(c.id);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('round-trips run records', async () => {
    const record: EnrichmentRunRecord = {
      runId: 'r-123',
      status: 'running',
      startedAt: new Date().toISOString(),
      stats: {
        docsScanned: 5,
        docsSkipped: 1,
        candidatesExtracted: 10,
        conceptsCreated: 3,
        conceptsUpdated: 2,
        errors: [],
      },
    };
    await conceptStore.putRun(record);
    const got = await conceptStore.getRun('r-123');
    expect(got).toEqual(record);
  });

  it('deletes a concept', async () => {
    await conceptStore.put(fakeConcept('x', 'X'));
    await conceptStore.delete('x');
    expect(await conceptStore.get('x')).toBeNull();
  });
});
