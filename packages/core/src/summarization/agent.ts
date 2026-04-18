import { randomUUID } from 'node:crypto';

import type { DocumentStore } from '@kepler/shared';

import type { LlmClient } from '../enrichment/llm/llm-client.js';
import type { GraphClient } from '../graph/graph-client.js';
import { createLogger, type Logger } from '../logger.js';

import { CommunityPriorityQueue } from './priority-queue.js';
import type { PriorityWeights } from './priority-queue.js';
import { RunLogger } from './run-logger.js';
import type { SourceAccess } from './source-access.js';
import {
  expand_callees,
  get_community,
  get_coverage_report,
  get_existing_summary,
  get_node,
  list_pending_communities,
  mark_cluster_complete,
  read_file_range,
  write_summary,
} from './tools.js';
import type {
  CommunityResult,
  CoverageReport,
  SummarizationToolContext,
  SummaryPayload,
  SymbolDetail,
  SymbolStub,
} from './tools.js';

export type SummarizationMode = 'full' | 'incremental' | 'priority-only';
export type SummarizationRunStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface SummarizationRunStats {
  symbolSummariesWritten: number;
  communitySummariesWritten: number;
  communitiesProcessed: number;
  estimatedCostUSD: number;
  validationValidated: number;
  validationPartial: number;
  validationUnvalidated: number;
}

export interface SummarizationRunRecord {
  runId: string;
  mode: SummarizationMode;
  repo: string;
  status: SummarizationRunStatus;
  startedAt: string;
  endedAt?: string;
  stats?: SummarizationRunStats;
  error?: string;
}

export interface SummarizationAgentDeps {
  graph: GraphClient;
  store: DocumentStore;
  sourceAccess: SourceAccess;
  /** LLM client configured with the navigation/haiku model. */
  navigationLlm: LlmClient;
  /** LLM client configured with the summary/sonnet model. */
  summaryLlm: LlmClient;
  logger?: Logger;
  priorityWeights?: PriorityWeights;
}

export interface SummarizationAgentConfig {
  /** Repo name to summarize. Required. */
  repo: string;
  mode: SummarizationMode;
  /** Embedding model identifier (for SymbolSummary nodes). */
  embeddingModel: string;
  /** Maximum USD to spend in one run. 0 = unlimited. */
  maxRunCostUSD: number;
}

// Canonical threshold: pageRank ≥ 0.05, isPublicApi, or communityRole = 'bridge'.
const CANONICAL_PAGE_RANK = 0.05;
// Approx. cost per 1K tokens in USD for Bedrock (rough estimate).
const COST_PER_1K_INPUT_TOKENS = 0.0003;
const COST_PER_1K_OUTPUT_TOKENS = 0.0015;

/** Rough character-to-token ratio. */
function charsToTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function estimateCost(inputChars: number, outputChars: number): number {
  return (
    (charsToTokens(inputChars) / 1000) * COST_PER_1K_INPUT_TOKENS +
    (charsToTokens(outputChars) / 1000) * COST_PER_1K_OUTPUT_TOKENS
  );
}

/**
 * Agentic summarization agent. Processes communities in priority order,
 * generating provisional and canonical summaries with LLM calls and writing
 * them to the graph. Exposes a fire-and-forget `trigger()` API.
 */
export class SummarizationAgent {
  private readonly log: Logger;
  private readonly runs = new Map<string, SummarizationRunRecord>();
  private lastRun: SummarizationRunRecord | undefined;

  // Prometheus-style in-memory gauges updated after each run.
  gauges = {
    canonicalPct: 0,
    staleCount: 0,
    lastRunCostUSD: 0,
  };

  constructor(private readonly deps: SummarizationAgentDeps) {
    this.log = deps.logger ?? createLogger('summarization-agent');
  }

  /** Starts a summarization run in the background. Returns the runId. */
  trigger(cfg: SummarizationAgentConfig): string {
    const runId = randomUUID();
    const record: SummarizationRunRecord = {
      runId,
      mode: cfg.mode,
      repo: cfg.repo,
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    this.runs.set(runId, record);

    this.executeRun(runId, cfg).catch((error) => {
      const existing = this.runs.get(runId);
      if (existing) {
        existing.status = 'failed';
        existing.endedAt = new Date().toISOString();
        existing.error = error instanceof Error ? error.message : String(error);
        this.lastRun = existing;
      }
      this.log.error('summarization run failed', { runId, error: String(error) });
    });

    return runId;
  }

  getRunStatus(runId: string): SummarizationRunRecord | undefined {
    return this.runs.get(runId);
  }

  getLastRun(): SummarizationRunRecord | undefined {
    return this.lastRun;
  }

  private async executeRun(runId: string, cfg: SummarizationAgentConfig): Promise<void> {
    const record = this.runs.get(runId)!;
    record.status = 'running';
    this.log.info('summarization run started', { runId, mode: cfg.mode, repo: cfg.repo });

    const runLogger = new RunLogger(this.deps.store, runId, this.log);
    const toolCtx: SummarizationToolContext = {
      graph: this.deps.graph,
      sourceAccess: this.deps.sourceAccess,
      logger: runLogger,
    };

    const stats: SummarizationRunStats = {
      symbolSummariesWritten: 0,
      communitySummariesWritten: 0,
      communitiesProcessed: 0,
      estimatedCostUSD: 0,
      validationValidated: 0,
      validationPartial: 0,
      validationUnvalidated: 0,
    };

    try {
      // Check cost ceiling via coverage report.
      const coverage = await get_coverage_report(cfg.repo, toolCtx);
      if (
        cfg.maxRunCostUSD > 0 &&
        coverage.estimatedCostToComplete > cfg.maxRunCostUSD * 2
      ) {
        this.log.warn('projected cost exceeds 2× ceiling; running priority-only', {
          runId,
          estimatedCostToComplete: coverage.estimatedCostToComplete,
          maxRunCostUSD: cfg.maxRunCostUSD,
        });
      }

      // Seed the priority queue.
      const pending = await list_pending_communities(cfg.repo, toolCtx);
      const queue = new CommunityPriorityQueue();
      for (const stub of pending) {
        queue.push({ communityId: stub.communityId, repo: cfg.repo, score: stub.priorityScore });
      }

      this.log.info('priority queue seeded', { runId, pendingCommunities: queue.size });

      // Process communities.
      while (!queue.isEmpty()) {
        const entry = queue.pop()!;

        // Cost ceiling check before each community.
        if (cfg.maxRunCostUSD > 0 && stats.estimatedCostUSD >= cfg.maxRunCostUSD) {
          this.log.warn('cost ceiling reached; stopping run', {
            runId,
            spent: stats.estimatedCostUSD,
            ceiling: cfg.maxRunCostUSD,
          });
          break;
        }

        // Acquire in-memory lock (V1 single-agent simplification).
        const lockKey = `${cfg.repo}:${entry.communityId}`;
        if (this.isLocked(lockKey)) continue;
        this.lock(lockKey);

        try {
          const communityCost = await this.processCommunity(
            entry.communityId,
            cfg,
            toolCtx,
            stats,
            runId,
          );
          stats.estimatedCostUSD += communityCost;
          stats.communitiesProcessed++;
        } finally {
          this.unlock(lockKey);
        }
      }

      // Flush run log.
      await runLogger.flush();

      // Update coverage gauges.
      await this.refreshGauges(cfg.repo, coverage, stats);

      record.status = 'complete';
      record.endedAt = new Date().toISOString();
      record.stats = stats;
      this.lastRun = record;
      this.log.info('summarization run complete', { runId, stats });
    } catch (error) {
      await runLogger.flush().catch(() => {});
      throw error;
    }
  }

  /** Processes one community cluster. Returns estimated USD cost. */
  private async processCommunity(
    communityId: number,
    cfg: SummarizationAgentConfig,
    toolCtx: SummarizationToolContext,
    stats: SummarizationRunStats,
    runId: string,
  ): Promise<number> {
    this.log.debug('processing community', { runId, communityId, repo: cfg.repo });
    let cost = 0;

    const community = await get_community(communityId, toolCtx);
    if (community.members.length === 0) {
      await mark_cluster_complete(communityId, cfg.repo, 1, toolCtx);
      return 0;
    }

    // Identify focal set (top-10 by pageRank + bridge symbols).
    const focalSet = selectFocalSet(community);

    // Load full symbol details for the focal set.
    const focalDetails: SymbolDetail[] = [];
    for (const stub of focalSet) {
      const detail = await get_node(stub.symbolId, toolCtx);
      if (detail) focalDetails.push(detail);
    }

    // Read source for focal symbols (up to 500 lines each).
    const sourceBySymbolId = new Map<string, string>();
    for (const detail of focalDetails) {
      if (detail.lineStart > 0 && detail.lineEnd > 0) {
        try {
          const src = await read_file_range(
            cfg.repo,
            detail.filePath,
            detail.lineStart,
            detail.lineEnd,
            toolCtx,
          );
          sourceBySymbolId.set(detail.symbolId, src);
        } catch {
          // Source unreadable — continue without it.
        }
      }
    }

    // Load cross-community callee summaries for boundary/bridge symbols.
    const crossCommunitySummaries: string[] = [];
    for (const stub of focalSet.filter((s) => s.communityRole !== 'core').slice(0, 5)) {
      const callees = await expand_callees(stub.symbolId, toolCtx, 1, true);
      for (const callee of callees.slice(0, 5)) {
        const existing = await get_existing_summary(callee.symbolId, toolCtx);
        if (existing) {
          crossCommunitySummaries.push(`${callee.name}: ${existing.purpose}`);
        }
      }
    }

    // Build community context string.
    const communityContext = buildCommunityContext(community, crossCommunitySummaries);

    // --- Generate summaries (egress pattern: build context first, write all at once) ---

    // Canonical summaries for focal set.
    for (const detail of focalDetails) {
      const isCanonical = isCanonicalThreshold(detail);
      const source = sourceBySymbolId.get(detail.symbolId) ?? '';
      const tier = isCanonical ? 'canonical' : 'provisional';
      const llm = isCanonical ? this.deps.summaryLlm : this.deps.navigationLlm;

      const { payload, inputChars, outputChars } = await this.generateSymbolSummary(
        detail,
        source,
        communityContext,
        tier,
        llm,
        runId,
      );
      cost += estimateCost(inputChars, outputChars);

      // Validation loop for canonical summaries.
      let result = await write_summary(
        { kind: 'symbol', symbolId: detail.symbolId },
        payload,
        toolCtx,
      );

      if (isCanonical && result.validation.status !== 'validated' && payload.assertions) {
        // One retry with correction prompt.
        const correctionContext = `${communityContext}\n\nCorrection: The following assertions did not match the graph: ${result.validation.failedAssertions.join(', ')}. Please omit those assertions.`;
        const retryResult = await this.generateSymbolSummary(
          detail,
          source,
          correctionContext,
          tier,
          llm,
          runId,
        );
        cost += estimateCost(retryResult.inputChars, retryResult.outputChars);
        result = await write_summary(
          { kind: 'symbol', symbolId: detail.symbolId },
          retryResult.payload,
          toolCtx,
        );
      }

      stats.symbolSummariesWritten++;
      if (result.validation.status === 'validated') stats.validationValidated++;
      else if (result.validation.status === 'partial') stats.validationPartial++;
      else stats.validationUnvalidated++;
    }

    // Provisional summaries for non-focal members.
    const nonFocalMembers = community.members.filter(
      (m) => !focalSet.some((f) => f.symbolId === m.symbolId),
    );
    for (const stub of nonFocalMembers) {
      // Skip if already has a non-stale canonical summary.
      if (stub.hasSummary && stub.summaryTier === 'canonical') continue;

      const { payload, inputChars, outputChars } = await this.generateProvisionalSummary(
        stub,
        communityContext,
        runId,
      );
      cost += estimateCost(inputChars, outputChars);

      await write_summary({ kind: 'symbol', symbolId: stub.symbolId }, payload, toolCtx);
      stats.symbolSummariesWritten++;
      stats.validationUnvalidated++;
    }

    // Community-level summary.
    const { payload: communityPayload, inputChars: ci, outputChars: co } =
      await this.generateCommunitySummary(community, focalDetails, communityContext, runId);
    cost += estimateCost(ci, co);
    await write_summary({ kind: 'community', communityId, repo: cfg.repo }, communityPayload, toolCtx);
    stats.communitySummariesWritten++;

    // Mark done.
    const coveragePct =
      focalDetails.length / Math.max(1, community.members.length);
    await mark_cluster_complete(communityId, cfg.repo, coveragePct, toolCtx);

    return cost;
  }

  // ---------------------------------------------------------------------------
  // LLM generation helpers
  // ---------------------------------------------------------------------------

  private async generateSymbolSummary(
    detail: SymbolDetail,
    source: string,
    communityContext: string,
    tier: 'provisional' | 'canonical',
    llm: LlmClient,
    runId: string,
  ): Promise<{ payload: SummaryPayload; inputChars: number; outputChars: number }> {
    const systemPrompt =
      'You are a code documentation agent. Generate a structured JSON summary of the given symbol. ' +
      'Respond with only valid JSON — no markdown fences, no explanation.';

    const userPrompt = buildSymbolPrompt(detail, source, communityContext, tier);
    const inputChars = systemPrompt.length + userPrompt.length;

    let raw = '';
    try {
      const resp = await llm.complete({
        systemPrompt,
        userPrompt,
        maxTokens: tier === 'canonical' ? 700 : 200,
        jsonMode: true,
      });
      raw = resp.text;
    } catch (error) {
      this.log.warn('llm completion failed for symbol', {
        runId,
        symbolId: detail.symbolId,
        error: String(error),
      });
      raw = JSON.stringify({
        purpose: `${detail.kind} ${detail.name}`,
        semanticTags: [],
        tier,
        coverageFlags: [],
      });
    }

    const payload = parseSummaryPayload(raw, tier, detail);
    return { payload, inputChars, outputChars: raw.length };
  }

  private async generateProvisionalSummary(
    stub: SymbolStub,
    communityContext: string,
    runId: string,
  ): Promise<{ payload: SummaryPayload; inputChars: number; outputChars: number }> {
    const systemPrompt =
      'You are a code documentation agent. Generate a brief JSON summary. ' +
      'Respond with only valid JSON.';

    const userPrompt =
      `Symbol: ${stub.name} (${stub.kind})\n` +
      `Docstring: ${stub.docstring ?? 'none'}\n` +
      `Community context: ${communityContext.slice(0, 300)}\n\n` +
      'Return JSON: { "purpose": "one sentence max 120 chars", "semanticTags": ["tag1"] }';

    const inputChars = systemPrompt.length + userPrompt.length;
    let raw = '';

    try {
      const resp = await this.deps.navigationLlm.complete({
        systemPrompt,
        userPrompt,
        maxTokens: 150,
        jsonMode: true,
      });
      raw = resp.text;
    } catch (error) {
      this.log.warn('llm completion failed for provisional summary', {
        runId,
        symbolId: stub.symbolId,
        error: String(error),
      });
      raw = JSON.stringify({ purpose: `${stub.kind} ${stub.name}`, semanticTags: [] });
    }

    let parsed: { purpose?: string; semanticTags?: string[] } = {};
    try {
      parsed = JSON.parse(raw) as { purpose?: string; semanticTags?: string[] };
    } catch {
      parsed = { purpose: `${stub.kind} ${stub.name}`, semanticTags: [] };
    }

    const payload: SummaryPayload = {
      purpose: String(parsed.purpose ?? `${stub.kind} ${stub.name}`).slice(0, 150),
      semanticTags: Array.isArray(parsed.semanticTags) ? parsed.semanticTags.slice(0, 5) : [],
      tier: 'provisional',
      coverageFlags: stub.docstring ? ['docstring'] : [],
    };
    return { payload, inputChars, outputChars: raw.length };
  }

  private async generateCommunitySummary(
    community: CommunityResult,
    focalDetails: SymbolDetail[],
    communityContext: string,
    runId: string,
  ): Promise<{ payload: SummaryPayload; inputChars: number; outputChars: number }> {
    const systemPrompt =
      'You are a code documentation agent. Generate a community-level JSON summary. ' +
      'Respond with only valid JSON.';

    const topSymbols = focalDetails
      .slice(0, 5)
      .map((d) => `${d.name} (${d.kind})`)
      .join(', ');
    const userPrompt =
      `Community ${community.communityId} in repo ${community.repo}\n` +
      `Size: ${community.members.length} symbols\n` +
      `Top symbols: ${topSymbols}\n` +
      `Context: ${communityContext.slice(0, 500)}\n\n` +
      'Return JSON: { "name": "short cluster name", "purpose": "2-3 sentence description of what this cluster does", ' +
      '"externalDependencies": ["dep1"] }';

    const inputChars = systemPrompt.length + userPrompt.length;
    let raw = '';

    try {
      const resp = await this.deps.navigationLlm.complete({
        systemPrompt,
        userPrompt,
        maxTokens: 300,
        jsonMode: true,
      });
      raw = resp.text;
    } catch (error) {
      this.log.warn('llm completion failed for community summary', {
        runId,
        communityId: community.communityId,
        error: String(error),
      });
      raw = JSON.stringify({
        name: `Community ${community.communityId}`,
        purpose: `A cluster of ${community.members.length} symbols in ${community.repo}.`,
        externalDependencies: [],
      });
    }

    let parsed: { name?: string; purpose?: string; externalDependencies?: string[] } = {};
    try {
      parsed = JSON.parse(raw) as { name?: string; purpose?: string; externalDependencies?: string[] };
    } catch {
      parsed = { name: `Community ${community.communityId}`, purpose: '', externalDependencies: [] };
    }

    const payload: SummaryPayload = {
      purpose: String(parsed.purpose ?? '').slice(0, 500) || `Cluster of ${community.members.length} symbols.`,
      semanticTags: [],
      tier: 'canonical',
      coverageFlags: ['community-context'],
      name: String(parsed.name ?? `Community ${community.communityId}`),
      externalDependencies: Array.isArray(parsed.externalDependencies)
        ? parsed.externalDependencies.slice(0, 10)
        : [],
    };
    return { payload, inputChars, outputChars: raw.length };
  }

  // ---------------------------------------------------------------------------
  // Lock helpers (in-memory, single-agent V1)
  // ---------------------------------------------------------------------------

  private readonly locks = new Set<string>();

  private isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  private lock(key: string): void {
    this.locks.add(key);
  }

  private unlock(key: string): void {
    this.locks.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Gauge refresh
  // ---------------------------------------------------------------------------

  private async refreshGauges(
    repo: string,
    coverage: CoverageReport,
    stats: SummarizationRunStats,
  ): Promise<void> {
    const total = coverage.totalSymbols + stats.symbolSummariesWritten;
    this.gauges.canonicalPct =
      total > 0
        ? ((coverage.symbolsWithCanonical + stats.symbolSummariesWritten) / total) * 100
        : 0;
    this.gauges.staleCount = coverage.staleCanonical;
    this.gauges.lastRunCostUSD = stats.estimatedCostUSD;
    this.log.debug('gauges refreshed', { repo, ...this.gauges });
  }
}

// ---------------------------------------------------------------------------
// Prompt builders and parsers
// ---------------------------------------------------------------------------

function buildCommunityContext(
  community: CommunityResult,
  crossCommunitySummaries: string[],
): string {
  const topMembers = community.members
    .slice(0, 10)
    .map((m) => `  - ${m.name} (${m.kind}, pageRank=${m.pageRank.toFixed(3)})`)
    .join('\n');
  let ctx =
    `Community ${community.communityId} in repo ${community.repo}:\n` +
    `  Size: ${community.members.length}, Cohesion: ${community.cohesion.toFixed(2)}\n` +
    `  Top members:\n${topMembers}`;
  if (crossCommunitySummaries.length > 0) {
    ctx +=
      '\n  External dependencies:\n' +
      crossCommunitySummaries.map((s) => `    - ${s}`).join('\n');
  }
  return ctx;
}

function buildSymbolPrompt(
  detail: SymbolDetail,
  source: string,
  communityContext: string,
  tier: 'provisional' | 'canonical',
): string {
  const sourceSection = source
    ? `\nSource (lines ${detail.lineStart}-${detail.lineEnd}):\n\`\`\`\n${source.slice(0, 3000)}\n\`\`\``
    : '';

  const baseFields =
    `Symbol: ${detail.name} (${detail.kind})\n` +
    `File: ${detail.filePath}\n` +
    `Signature: ${detail.signature}\n` +
    `Docstring: ${detail.docstring ?? 'none'}\n` +
    `Behavioral: hasIO=${detail.hasIO}, hasMutation=${detail.hasMutation}, isPure=${detail.isPure}\n` +
    `Effects: ${detail.effectKinds.join(', ') || 'none'}\n` +
    `Community context:\n${communityContext}` +
    sourceSection;

  if (tier === 'provisional') {
    return (
      baseFields +
      '\n\nReturn JSON: { "purpose": "one sentence max 120 chars", ' +
      '"semanticTags": ["tag1", "tag2"], "tier": "provisional", "coverageFlags": [] }'
    );
  }

  return (
    baseFields +
    '\n\nReturn JSON with fields: purpose (string, max 150 chars), details (string, 2-5 sentences), ' +
    'sideEffects (string|null), semanticTags (string[], 1-10 tags), ' +
    (detail.testCoverage ? 'examplesFromTests (string|null), ' : '') +
    'tier ("canonical"), coverageFlags (string[]), ' +
    'assertions ({ calls?: string[], throws?: string[], reads_config?: string[] })'
  );
}

function parseSummaryPayload(
  raw: string,
  tier: 'provisional' | 'canonical',
  detail: SymbolDetail,
): SummaryPayload {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  return {
    purpose: String(parsed['purpose'] ?? `${detail.kind} ${detail.name}`).slice(0, 150),
    details: typeof parsed['details'] === 'string' ? parsed['details'].slice(0, 600) : undefined,
    sideEffects:
      typeof parsed['sideEffects'] === 'string' ? parsed['sideEffects'].slice(0, 300) : undefined,
    semanticTags: Array.isArray(parsed['semanticTags'])
      ? (parsed['semanticTags'] as string[]).slice(0, 10)
      : [],
    examplesFromTests:
      typeof parsed['examplesFromTests'] === 'string'
        ? parsed['examplesFromTests'].slice(0, 400)
        : undefined,
    tier,
    coverageFlags: Array.isArray(parsed['coverageFlags'])
      ? (parsed['coverageFlags'] as string[])
      : buildCoverageFlags(detail),
    assertions:
      parsed['assertions'] &&
      typeof parsed['assertions'] === 'object' &&
      !Array.isArray(parsed['assertions'])
        ? (parsed['assertions'] as SummaryPayload['assertions'])
        : undefined,
  };
}

function buildCoverageFlags(detail: SymbolDetail): string[] {
  const flags: string[] = [];
  if (detail.docstring) flags.push('docstring');
  if (detail.testCoverage) flags.push('tests');
  return flags;
}

function selectFocalSet(community: CommunityResult): SymbolStub[] {
  const byPageRank = [...community.members].sort((a, b) => b.pageRank - a.pageRank);
  const top10 = byPageRank.slice(0, 10);
  const bridges = community.members.filter(
    (m) => m.communityRole === 'bridge' && !top10.some((t) => t.symbolId === m.symbolId),
  );
  return [...top10, ...bridges];
}

function isCanonicalThreshold(detail: SymbolDetail): boolean {
  return detail.pageRank >= CANONICAL_PAGE_RANK || detail.isPublicApi || detail.communityRole === 'bridge';
}
