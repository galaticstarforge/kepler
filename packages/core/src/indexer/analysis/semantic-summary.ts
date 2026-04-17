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
  /** Hash of the symbol source text at generation time. */
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
}

/**
 * Agentic summarization subsystem. Generates `SymbolSummary` and
 * `CommunitySummary` nodes with vector embeddings, emits `HAS_SUMMARY`,
 * `HAS_COMMUNITY_SUMMARY`, and `SUMMARIZED_IN_CONTEXT_OF` edges, and detects
 * staleness via `contentHash` vs `Symbol.hash`.
 *
 * Persistence (vector indexes, node writes, staleness detection) is fully
 * implemented; the LLM-dependent `generateSymbolSummary` /
 * `generateCommunitySummary` methods throw because they require an LLM
 * client that the caller must wire in (see enrichment/llm/llm-client.ts).
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
    this.log.info('semantic summary pass requested', { repo: config.repo });
    // Generation requires an LLM client; the caller should wire one in and
    // invoke writeSymbolSummary / writeCommunitySummary directly. See the
    // class-level JSDoc.
    throw new NotImplementedError(
      'Semantic summary orchestrator — requires LLM client',
      'docs/graph/semantic-enrichment.md#node-types-added',
    );
  }

  /**
   * Ensures the vector indexes defined in the docs exist. Safe to call
   * repeatedly. Drops-and-recreates is the caller's responsibility when
   * the embedding model's dimension count changes.
   */
  async ensureVectorIndexes(dimensions: number): Promise<void> {
    await this.deps.graph.applySchema([
      `CREATE VECTOR INDEX symbol_summary_embedding IF NOT EXISTS
       FOR (ss:SymbolSummary) ON ss.embedding
       OPTIONS { indexConfig: {
         \`vector.dimensions\`: ${dimensions},
         \`vector.similarity_function\`: 'cosine'
       } }`,
      `CREATE VECTOR INDEX community_summary_embedding IF NOT EXISTS
       FOR (cs:CommunitySummary) ON cs.embedding
       OPTIONS { indexConfig: {
         \`vector.dimensions\`: ${dimensions},
         \`vector.similarity_function\`: 'cosine'
       } }`,
    ]);
  }

  async generateSymbolSummary(symbolFqn: string): Promise<SymbolSummary> {
    this.log.debug('generateSymbolSummary called', { symbolFqn });
    throw new NotImplementedError(
      'Per-symbol summary generation — requires LLM client',
      'docs/graph/semantic-enrichment.md#symbolsummary',
    );
  }

  async generateCommunitySummary(
    communityId: number,
    repo: string,
  ): Promise<CommunitySummary> {
    this.log.debug('generateCommunitySummary called', { communityId, repo });
    throw new NotImplementedError(
      'Per-community summary generation — requires LLM client',
      'docs/graph/semantic-enrichment.md#communitysummary',
    );
  }

  /**
   * Writes (replaces) a `SymbolSummary` for the symbol identified by
   * `symbolFqn` of the form `repo:filePath#symbolName`, plus the
   * `HAS_SUMMARY` edge. Previous summaries on the symbol are replaced.
   */
  async writeSymbolSummary(summary: SymbolSummary): Promise<void> {
    const { repo, filePath, name } = parseSymbolFqn(summary.symbolFqn);
    await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
       OPTIONAL MATCH (s)-[old:HAS_SUMMARY]->(prev:SymbolSummary)
       DELETE old, prev
       WITH s
       CREATE (ss:SymbolSummary {
         symbolFqn:         $summary.symbolFqn,
         purpose:           $summary.purpose,
         details:           $summary.details,
         sideEffects:       $summary.sideEffects,
         semanticTags:      $summary.semanticTags,
         examplesFromTests: $summary.examplesFromTests,
         tier:              $summary.tier,
         model:             $summary.model,
         generatedAt:       $summary.generatedAt,
         contentHash:       $summary.contentHash,
         coverageFlags:     $summary.coverageFlags,
         embedding:         $summary.embedding,
         embeddingModel:    $summary.embeddingModel
       })
       MERGE (s)-[:HAS_SUMMARY]->(ss)`,
      { repo, filePath, name, summary },
    );
  }

  /**
   * Writes (replaces) a `CommunitySummary` + `HAS_COMMUNITY_SUMMARY` edge.
   */
  async writeCommunitySummary(summary: CommunitySummary): Promise<void> {
    await this.deps.graph.runWrite(
      `MATCH (c:Community {repo: $summary.repo, communityId: $summary.communityId})
       OPTIONAL MATCH (c)-[old:HAS_COMMUNITY_SUMMARY]->(prev:CommunitySummary)
       DELETE old, prev
       WITH c
       CREATE (cs:CommunitySummary {
         communityId:          $summary.communityId,
         repo:                 $summary.repo,
         name:                 $summary.name,
         purpose:              $summary.purpose,
         keySymbols:           $summary.keySymbols,
         externalDependencies: $summary.externalDependencies,
         tier:                 $summary.tier,
         model:                $summary.model,
         generatedAt:          $summary.generatedAt,
         symbolCount:          $summary.symbolCount,
         coveragePct:          $summary.coveragePct,
         embedding:            $summary.embedding,
         embeddingModel:       $summary.embeddingModel
       })
       MERGE (c)-[:HAS_COMMUNITY_SUMMARY]->(cs)`,
      { summary },
    );
  }

  /**
   * Marks summaries stale when the symbol's source hash has moved on.
   * Returns the number of summaries flagged stale during this call.
   */
  async detectStaleness(repo: string): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})-[:HAS_SUMMARY]->(ss:SymbolSummary)
       WHERE s.hash IS NOT NULL AND ss.contentHash <> s.hash
       SET ss.stale = true
       RETURN count(ss) AS n`,
      { repo },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }
}

function parseSymbolFqn(fqn: string): { repo: string; filePath: string; name: string } {
  const hashIdx = fqn.lastIndexOf('#');
  if (hashIdx === -1) throw new Error(`Invalid symbolFqn (missing '#'): ${fqn}`);
  const head = fqn.slice(0, hashIdx);
  const name = fqn.slice(hashIdx + 1);
  const colonIdx = head.indexOf(':');
  if (colonIdx === -1) throw new Error(`Invalid symbolFqn (missing ':'): ${fqn}`);
  return {
    repo: head.slice(0, colonIdx),
    filePath: head.slice(colonIdx + 1),
    name,
  };
}
