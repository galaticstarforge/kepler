import { randomUUID } from 'node:crypto';

import type {
  Concept,
  ConceptMention,
  DocumentStore,
  EnrichmentRunRecord,
  EnrichmentRunStats,
  ExtractionCandidate,
} from '@keplerforge/shared';
import { CONCEPTS_PREFIX, EnrichmentError } from '@keplerforge/shared';

import type { ConceptExtractionConfig } from '../config.js';
import type { GraphClient } from '../graph/graph-client.js';
import { createLogger } from '../logger.js';

import type { ConceptExtractor } from './concept-extractor.js';
import type { ConceptStore } from './concept-store.js';
import { cosine, decodeEmbedding, encodeEmbedding, slugify } from './dedup.js';
import type { LlmClient } from './llm/llm-client.js';

const log = createLogger('enrichment-runner');

export interface EnrichmentRunnerDeps {
  store: DocumentStore;
  conceptStore: ConceptStore;
  extractor: ConceptExtractor;
  llm: LlmClient;
  config: ConceptExtractionConfig;
  graph: GraphClient;
}

export interface EnrichmentRunOptions {
  /** If set, restrict to documents whose path starts with this prefix. */
  pathPrefix?: string;
}

/**
 * Orchestrates a concept-extraction pass across the document store.
 *
 * Contract: `start` returns immediately with a runId. The actual work
 * proceeds asynchronously; progress and final stats land in the concept
 * run record (readable via ConceptStore.getRun).
 */
export class EnrichmentRunner {
  constructor(private readonly deps: EnrichmentRunnerDeps) {}

  async start(opts: EnrichmentRunOptions = {}): Promise<EnrichmentRunRecord> {
    if (!this.deps.config.enabled || this.deps.config.provider === 'none') {
      throw new EnrichmentError(
        'Concept extraction is disabled. Set enrichment.conceptExtraction.enabled=true and provider=bedrock.',
      );
    }

    const runId = randomUUID();
    const record: EnrichmentRunRecord = {
      runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      stats: emptyStats(),
    };
    await this.deps.conceptStore.putRun(record);

    // Fire and log — do not await.
    void this.run(record, opts).catch((error: unknown) => {
      log.error('unhandled runner failure', { runId, error: String(error) });
    });

    return record;
  }

  private async run(record: EnrichmentRunRecord, opts: EnrichmentRunOptions): Promise<void> {
    const started = Date.now();
    const stats = record.stats;

    try {
      const existing = await this.loadExistingConcepts();
      const bySlug = new Map<string, Concept>();
      for (const c of existing) bySlug.set(c.id, c);
      const dirty = new Set<string>();
      const created = new Set<string>();

      for await (const head of this.deps.store.list(opts.pathPrefix ?? '')) {
        if (head.path.startsWith(CONCEPTS_PREFIX)) continue;
        if (!head.path.endsWith('.md')) continue;

        const bytes = await this.deps.store.get(head.path);
        if (!bytes) continue;
        const markdown = bytes.content.toString('utf8');
        if (markdown.length < this.deps.config.minDocChars) {
          stats.docsSkipped++;
          continue;
        }

        stats.docsScanned++;
        let candidates: ExtractionCandidate[];
        try {
          candidates = await this.deps.extractor.extract(head.path, markdown);
        } catch (error) {
          stats.errors.push(`extract ${head.path}: ${String(error)}`);
          continue;
        }
        stats.candidatesExtracted += candidates.length;

        for (const candidate of candidates) {
          const slug = slugify(candidate.name);
          if (!slug) continue;

          const fast = bySlug.get(slug);
          if (fast) {
            if (mergeMention(fast, head.path, candidate)) dirty.add(slug);
            continue;
          }

          let embedding: Float32Array;
          try {
            const embedResp = await this.deps.llm.embed({
              text: combinedText(candidate),
            });
            embedding = embedResp.vector;
          } catch (error) {
            stats.errors.push(`embed ${candidate.name}: ${String(error)}`);
            continue;
          }

          const match = findNearest(embedding, bySlug, this.deps.config.similarityThreshold);
          if (match) {
            if (mergeMention(match, head.path, candidate)) dirty.add(match.id);
            continue;
          }

          const concept = createConcept(slug, candidate, embedding, this.deps.config.embeddingModel, head.path);
          bySlug.set(slug, concept);
          created.add(slug);
        }
      }

      for (const slug of created) {
        const c = bySlug.get(slug);
        if (c) await this.deps.conceptStore.put(c);
      }
      for (const slug of dirty) {
        if (created.has(slug)) continue;
        const c = bySlug.get(slug);
        if (c) await this.deps.conceptStore.put(c);
      }

      stats.conceptsCreated = created.size;
      stats.conceptsUpdated = [...dirty].filter((s) => !created.has(s)).length;

      // Persist concepts and their mentions to the graph.
      const toSync = new Set([...created, ...[...dirty].filter((s) => !created.has(s))]);
      for (const slug of toSync) {
        const c = bySlug.get(slug);
        if (!c) continue;
        try {
          await this.deps.graph.runWrite(
            `MERGE (c:Concept {id: $id})
             SET c.name        = $name,
                 c.description = $description,
                 c.createdAt   = $createdAt,
                 c.updatedAt   = $updatedAt
             WITH c
             UNWIND $mentions AS m
             MERGE (d:Document {path: m.docPath})
             MERGE (c)-[r:MENTIONED_IN]->(d)
             SET r.confidence  = m.confidence,
                 r.extractedAt = m.extractedAt`,
            {
              id:          c.id,
              name:        c.name,
              description: c.description ?? null,
              createdAt:   c.createdAt,
              updatedAt:   c.updatedAt,
              mentions:    c.mentions.map((m) => ({
                docPath:     m.docPath,
                confidence:  m.confidence,
                extractedAt: m.extractedAt,
              })),
            },
          );
        } catch (graphError) {
          stats.errors.push(`graph sync ${c.id}: ${String(graphError)}`);
        }
      }

      record.status = 'completed';
    } catch (error) {
      log.error('run failed', { runId: record.runId, error: String(error) });
      record.status = 'failed';
      record.error = String(error);
    } finally {
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.now() - started;
      await this.deps.conceptStore.putRun(record);
    }
  }

  private async loadExistingConcepts(): Promise<Concept[]> {
    const out: Concept[] = [];
    for await (const c of this.deps.conceptStore.list()) {
      out.push(c);
    }
    return out;
  }
}

function emptyStats(): EnrichmentRunStats {
  return {
    docsScanned: 0,
    docsSkipped: 0,
    candidatesExtracted: 0,
    conceptsCreated: 0,
    conceptsUpdated: 0,
    errors: [],
  };
}

function combinedText(c: ExtractionCandidate): string {
  return c.description ? `${c.name}. ${c.description}` : c.name;
}

function findNearest(
  query: Float32Array,
  bySlug: Map<string, Concept>,
  threshold: number,
): Concept | null {
  let best: Concept | null = null;
  let bestScore = threshold;
  for (const concept of bySlug.values()) {
    const vec = decodeEmbedding(concept.embeddingB64);
    const score = cosine(query, vec);
    if (score > bestScore) {
      bestScore = score;
      best = concept;
    }
  }
  return best;
}

function mergeMention(
  concept: Concept,
  docPath: string,
  candidate: ExtractionCandidate,
): boolean {
  const existing = concept.mentions.find((m) => m.docPath === docPath);
  const now = new Date().toISOString();

  if (existing) {
    let changed = false;
    if (candidate.confidence > existing.confidence) {
      existing.confidence = candidate.confidence;
      changed = true;
    }
    if (candidate.evidenceSpan && candidate.evidenceSpan !== existing.evidenceSpan) {
      existing.evidenceSpan = candidate.evidenceSpan;
      changed = true;
    }
    if (changed) {
      existing.extractedAt = now;
      concept.updatedAt = now;
    }
    return changed;
  }

  const mention: ConceptMention = {
    docPath,
    confidence: candidate.confidence,
    extractedAt: now,
  };
  if (candidate.evidenceSpan) mention.evidenceSpan = candidate.evidenceSpan;
  concept.mentions.push(mention);
  concept.updatedAt = now;
  return true;
}

function createConcept(
  slug: string,
  candidate: ExtractionCandidate,
  embedding: Float32Array,
  embeddingModel: string,
  docPath: string,
): Concept {
  const now = new Date().toISOString();
  const mention: ConceptMention = {
    docPath,
    confidence: candidate.confidence,
    extractedAt: now,
  };
  if (candidate.evidenceSpan) mention.evidenceSpan = candidate.evidenceSpan;

  return {
    id: slug,
    name: candidate.name,
    description: candidate.description,
    embeddingB64: encodeEmbedding(embedding),
    embeddingModel,
    mentions: [mention],
    createdAt: now,
    updatedAt: now,
  };
}
