import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export type SummaryTier = 'provisional' | 'canonical';

export type SummaryCoverageFlag =
  | 'docstring'
  | 'callers'
  | 'callees'
  | 'tests'
  | 'community-context'
  | 'type-edges';

export interface SymbolSummary {
  symbolFqn: string;
  purpose: string;
  details: string;
  sideEffects: string | null;
  semanticTags: string[];
  examplesFromTests: string | null;
  tier: SummaryTier;
  model: string;
  generatedAt: string;
  /** BLAKE3 hash of the symbol source text at generation time. */
  contentHash: string;
  coverageFlags: SummaryCoverageFlag[];
  embedding: number[];
  embeddingModel: string;
}

export interface CommunitySummary {
  communityId: number;
  repo: string;
  name: string;
  purpose: string;
  keySymbols: string[];
  externalDependencies: string[];
  tier: SummaryTier;
  model: string;
  generatedAt: string;
  symbolCount: number;
  coveragePct: number;
  embedding: number[];
  embeddingModel: string;
}

export interface SymbolSummaryDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface SymbolSummaryConfig {
  repo: string;
  /** e.g. 'anthropic.claude-3-5-haiku-20241022' */
  summaryModel: string;
  embeddingModel: string;
  /** Vector dimensions expected by the configured embedding model. */
  embeddingDimensions: number;
  /** Maximum symbols to summarize in this pass. */
  batchSize?: number;
}

export interface SummarizationStats {
  symbolSummariesWritten: number;
  communitySummariesWritten: number;
  staleDetected: number;
  skippedByHash: number;
}

/**
 * Agentic summarization subsystem. Generates `SymbolSummary` and
 * `CommunitySummary` nodes with vector embeddings, emits `HAS_SUMMARY`,
 * `HAS_COMMUNITY_SUMMARY`, and `SUMMARIZED_IN_CONTEXT_OF` edges, and detects
 * staleness via `contentHash` vs `Symbol.hash`.
 *
 * See docs/graph/semantic-enrichment.md — sections SymbolSummary,
 * CommunitySummary, and Staleness Detection.
 */
export class SemanticSummaryPass {
  private readonly log: Logger;

  constructor(private readonly deps: SymbolSummaryDeps) {
    this.log = deps.logger ?? createLogger('semantic-summary');
  }

  async run(config: SymbolSummaryConfig): Promise<SummarizationStats> {
    this.log.info('semantic summary pass requested but not implemented', {
      repo: config.repo,
    });
    throw new NotImplementedError(
      'Semantic summary (SymbolSummary + CommunitySummary) pass',
      'docs/graph/semantic-enrichment.md#node-types-added',
    );
  }

  async ensureVectorIndexes(_dimensions: number): Promise<void> {
    throw new NotImplementedError(
      'Vector index creation/rebuild (symbol_summary_embedding, community_summary_embedding)',
      'docs/graph/semantic-enrichment.md#vector-index',
    );
  }

  async generateSymbolSummary(_symbolFqn: string): Promise<SymbolSummary> {
    throw new NotImplementedError(
      'Per-symbol summary generation',
      'docs/graph/semantic-enrichment.md#symbolsummary',
    );
  }

  async generateCommunitySummary(
    _communityId: number,
    _repo: string,
  ): Promise<CommunitySummary> {
    throw new NotImplementedError(
      'Per-community summary generation',
      'docs/graph/semantic-enrichment.md#communitysummary',
    );
  }

  async writeSymbolSummary(_summary: SymbolSummary): Promise<void> {
    throw new NotImplementedError(
      'SymbolSummary node write + HAS_SUMMARY + SUMMARIZED_IN_CONTEXT_OF edges',
      'docs/graph/semantic-enrichment.md#has_summary-symbol--symbolsummary',
    );
  }

  async writeCommunitySummary(_summary: CommunitySummary): Promise<void> {
    throw new NotImplementedError(
      'CommunitySummary node write + HAS_COMMUNITY_SUMMARY edge',
      'docs/graph/semantic-enrichment.md#has_community_summary-community--communitysummary',
    );
  }

  async detectStaleness(_repo: string): Promise<number> {
    throw new NotImplementedError(
      'Summary staleness detection (contentHash vs Symbol.hash + community drift)',
      'docs/graph/semantic-enrichment.md#staleness-detection',
    );
  }
}
