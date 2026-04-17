/**
 * Concept types for the document-side enrichment pipeline.
 *
 * Concepts are LLM-extracted named domain ideas (e.g. "fraud detection")
 * that appear across one or more documents. They are persisted as JSON
 * under the CONCEPTS_PREFIX of the existing DocumentStore.
 */

/** A single extraction candidate produced by the LLM for one document chunk. */
export interface ExtractionCandidate {
  name: string;
  description: string;
  confidence: number;
  evidenceSpan?: string;
}

/** One document's reference to a concept. */
export interface ConceptMention {
  docPath: string;
  confidence: number;
  evidenceSpan?: string;
  extractedAt: string;
}

/** Persisted concept record. Stored as JSON at `concepts/<id>.json`. */
export interface Concept {
  id: string;
  name: string;
  description: string;
  /** Base64-encoded Float32Array of the dedup embedding. */
  embeddingB64: string;
  embeddingModel: string;
  mentions: ConceptMention[];
  createdAt: string;
  updatedAt: string;
}

export type EnrichmentRunStatus = 'running' | 'completed' | 'failed';

export interface EnrichmentRunStats {
  docsScanned: number;
  docsSkipped: number;
  candidatesExtracted: number;
  conceptsCreated: number;
  conceptsUpdated: number;
  errors: string[];
}

/** Run record persisted under `concepts/_runs/<runId>.json`. */
export interface EnrichmentRunRecord {
  runId: string;
  status: EnrichmentRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stats: EnrichmentRunStats;
  error?: string;
}
