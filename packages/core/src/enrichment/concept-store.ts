import type {
  Concept,
  DocumentStore,
  EnrichmentRunRecord,
} from '@kepler/shared';
import {
  CONCEPTS_PREFIX,
  CONCEPT_RUNS_PREFIX,
  EnrichmentError,
} from '@kepler/shared';

import { createLogger } from '../logger.js';

const log = createLogger('concept-store');

/**
 * Persistence layer for Concept records and EnrichmentRunRecords.
 * Wraps the existing DocumentStore, storing JSON under `concepts/`.
 */
export class ConceptStore {
  constructor(private readonly store: DocumentStore) {}

  async get(id: string): Promise<Concept | null> {
    const bytes = await this.store.get(conceptPath(id));
    if (!bytes) return null;
    return parseConcept(bytes.content);
  }

  async put(concept: Concept): Promise<void> {
    const content = Buffer.from(JSON.stringify(concept, null, 2), 'utf8');
    await this.store.put(conceptPath(concept.id), content, {
      contentType: 'application/json',
      contentLength: content.byteLength,
      lastModified: new Date(),
      custom: { kind: 'concept', name: concept.name },
    });
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(conceptPath(id));
  }

  async *list(): AsyncIterable<Concept> {
    for await (const head of this.store.list(CONCEPTS_PREFIX)) {
      // Skip run logs and anything that isn't a top-level concept JSON.
      if (head.path.startsWith(CONCEPT_RUNS_PREFIX)) continue;
      if (!head.path.endsWith('.json')) continue;

      const bytes = await this.store.get(head.path);
      if (!bytes) continue;
      try {
        yield parseConcept(bytes.content);
      } catch (error) {
        log.warn('skipping malformed concept', { path: head.path, error: String(error) });
      }
    }
  }

  async putRun(record: EnrichmentRunRecord): Promise<void> {
    const content = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
    await this.store.put(runPath(record.runId), content, {
      contentType: 'application/json',
      contentLength: content.byteLength,
      lastModified: new Date(),
      custom: { kind: 'concept-run', status: record.status },
    });
  }

  async getRun(runId: string): Promise<EnrichmentRunRecord | null> {
    const bytes = await this.store.get(runPath(runId));
    if (!bytes) return null;
    try {
      return JSON.parse(bytes.content.toString('utf8')) as EnrichmentRunRecord;
    } catch (error) {
      throw new EnrichmentError(`Malformed run record for ${runId}`, error);
    }
  }
}

export function conceptPath(id: string): string {
  return `${CONCEPTS_PREFIX}${id}.json`;
}

export function runPath(runId: string): string {
  return `${CONCEPT_RUNS_PREFIX}${runId}.json`;
}

function parseConcept(content: Buffer): Concept {
  try {
    return JSON.parse(content.toString('utf8')) as Concept;
  } catch (error) {
    throw new EnrichmentError('Malformed concept JSON', error);
  }
}
