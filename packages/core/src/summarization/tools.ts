import type { GraphClient } from '../graph/graph-client.js';

import type { RunLogger } from './run-logger.js';
import type { SourceAccess } from './source-access.js';
import { MAX_FILE_READ_LINES } from './source-access.js';

// ---------------------------------------------------------------------------
// Shared context injected to every tool call
// ---------------------------------------------------------------------------

export interface SummarizationToolContext {
  graph: GraphClient;
  sourceAccess: SourceAccess;
  logger: RunLogger;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface SymbolStub {
  symbolId: string;
  name: string;
  kind: string;
  communityRole: string;
  pageRank: number;
  fanIn: number;
  isPublicApi: boolean;
  docstring: string | null;
  hasSummary: boolean;
  summaryTier: 'provisional' | 'canonical' | null;
}

export interface CommunityResult {
  communityId: number;
  repo: string;
  size: number;
  cohesion: number;
  members: SymbolStub[];
}

export interface SymbolDetail {
  symbolId: string;
  name: string;
  kind: string;
  signature: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isPublicApi: boolean;
  isPure: boolean;
  hasIO: boolean;
  hasMutation: boolean;
  effectKinds: string[];
  configKeysRead: string[];
  featureFlagsRead: string[];
  semanticTags: string[];
  docstring: string | null;
  architecturalLayer: string;
  boundedContextId: string | null;
  communityId: number;
  communityRole: string;
  pageRank: number;
  changeFrequency: number;
  authorCount: number;
  throwsTypes: string[];
  externalServices: string[];
  testCoverage: boolean;
}

export interface ExistingSummary {
  purpose: string;
  details: string | null;
  sideEffects: string | null;
  semanticTags: string[];
  tier: 'provisional' | 'canonical';
  isStale: boolean;
  generatedAt: string;
}

export interface CommunityStub {
  communityId: number;
  size: number;
  priorityScore: number;
  hasSummary: boolean;
  summaryAge: number | null;
}

export interface CoverageReport {
  totalSymbols: number;
  symbolsWithCanonical: number;
  symbolsWithProvisional: number;
  symbolsUnsummarized: number;
  staleCanonical: number;
  totalCommunities: number;
  communitiesWithSummary: number;
  estimatedCostToComplete: number;
}

export interface SummaryAssertions {
  calls?: string[];
  throws?: string[];
  reads_config?: string[];
}

export type SummaryTarget =
  | { kind: 'symbol'; symbolId: string }
  | { kind: 'community'; communityId: number; repo: string };

export interface SummaryPayload {
  purpose: string;
  details?: string;
  sideEffects?: string;
  semanticTags: string[];
  examplesFromTests?: string;
  tier: 'provisional' | 'canonical';
  coverageFlags: string[];
  assertions?: SummaryAssertions;
  name?: string;
  externalDependencies?: string[];
}

export type ValidationStatus = 'validated' | 'partial' | 'unvalidated';

export interface ValidationResult {
  status: ValidationStatus;
  failedAssertions: string[];
}

export interface WriteSummaryResult {
  validation: ValidationResult;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Returns the community metadata and a ranked list of its members.
 */
export async function get_community(
  communityId: number,
  ctx: SummarizationToolContext,
): Promise<CommunityResult> {
  const rows = await ctx.graph.runRead(
    `MATCH (c:Community {communityId: $communityId})
     OPTIONAL MATCH (s:Symbol)-[:MEMBER_OF]->(c)
     WITH c, s
     ORDER BY coalesce(s.pageRank, 0) DESC
     RETURN
       c.communityId AS communityId,
       c.repo AS repo,
       c.size AS size,
       coalesce(c.cohesion, 0.0) AS cohesion,
       collect({
         symbolId: s.repo + ':' + s.filePath + '#' + s.name,
         name: s.name,
         kind: s.kind,
         communityRole: coalesce(s.communityRole, 'core'),
         pageRank: coalesce(s.pageRank, 0.0),
         fanIn: coalesce(s.fanIn, 0),
         isPublicApi: coalesce(s.isPublicApi, false),
         docstring: s.docstring,
         hasSummary: exists { MATCH (s)-[:HAS_SUMMARY]->(:SymbolSummary) },
         summaryTier: [(s)-[:HAS_SUMMARY]->(ss:SymbolSummary) | ss.tier][0]
       }) AS members`,
    { communityId },
    (r) => ({
      communityId: Number(r.get('communityId')),
      repo: String(r.get('repo') ?? ''),
      size: Number(r.get('size') ?? 0),
      cohesion: Number(r.get('cohesion') ?? 0),
      members: (r.get('members') as SymbolStub[]).filter((m) => m.symbolId !== ':undefined#undefined'),
    }),
  );

  const result = rows[0] ?? { communityId, repo: '', size: 0, cohesion: 0, members: [] };
  ctx.logger.logCall('get_community', { communityId }, result);
  return result;
}

/**
 * Returns full detail for a single symbol identified by `symbolId`
 * of the form `repo:filePath#name`.
 */
export async function get_node(
  symbolId: string,
  ctx: SummarizationToolContext,
): Promise<SymbolDetail | null> {
  const { repo, filePath, name } = parseSymbolId(symbolId);
  const rows = await ctx.graph.runRead(
    `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
     OPTIONAL MATCH (s)-[:MEMBER_OF]->(c:Community)
     RETURN
       $repo + ':' + s.filePath + '#' + s.name AS symbolId,
       s.name AS name,
       s.kind AS kind,
       coalesce(s.signature, '') AS signature,
       s.filePath AS filePath,
       coalesce(s.lineStart, 0) AS lineStart,
       coalesce(s.lineEnd, 0) AS lineEnd,
       coalesce(s.isExported, false) AS isExported,
       coalesce(s.isPublicApi, false) AS isPublicApi,
       coalesce(s.isPure, false) AS isPure,
       coalesce(s.hasIO, false) AS hasIO,
       coalesce(s.hasMutation, false) AS hasMutation,
       coalesce(s.effectKinds, []) AS effectKinds,
       coalesce(s.configKeysRead, []) AS configKeysRead,
       coalesce(s.featureFlagsRead, []) AS featureFlagsRead,
       coalesce(s.semanticTags, []) AS semanticTags,
       s.docstring AS docstring,
       coalesce(s.architecturalLayer, 'unknown') AS architecturalLayer,
       s.boundedContextId AS boundedContextId,
       coalesce(c.communityId, -1) AS communityId,
       coalesce(s.communityRole, 'core') AS communityRole,
       coalesce(s.pageRank, 0.0) AS pageRank,
       coalesce(s.changeFrequency, 0.0) AS changeFrequency,
       coalesce(s.authorCount, 0) AS authorCount,
       [(s)-[:THROWS]->(e) | e.name] AS throwsTypes,
       [(s)-[:CALLS_SERVICE]->(svc) | svc.name] AS externalServices,
       exists { MATCH (:Symbol)-[:TEST_ASSERTS]->(s) } AS testCoverage`,
    { repo, filePath, name },
    (r) => ({
      symbolId: String(r.get('symbolId')),
      name: String(r.get('name')),
      kind: String(r.get('kind') ?? 'unknown'),
      signature: String(r.get('signature')),
      filePath: String(r.get('filePath')),
      lineStart: Number(r.get('lineStart')),
      lineEnd: Number(r.get('lineEnd')),
      isExported: Boolean(r.get('isExported')),
      isPublicApi: Boolean(r.get('isPublicApi')),
      isPure: Boolean(r.get('isPure')),
      hasIO: Boolean(r.get('hasIO')),
      hasMutation: Boolean(r.get('hasMutation')),
      effectKinds: (r.get('effectKinds') as string[]) ?? [],
      configKeysRead: (r.get('configKeysRead') as string[]) ?? [],
      featureFlagsRead: (r.get('featureFlagsRead') as string[]) ?? [],
      semanticTags: (r.get('semanticTags') as string[]) ?? [],
      docstring: r.get('docstring') as string | null,
      architecturalLayer: String(r.get('architecturalLayer')),
      boundedContextId: r.get('boundedContextId') as string | null,
      communityId: Number(r.get('communityId')),
      communityRole: String(r.get('communityRole')),
      pageRank: Number(r.get('pageRank')),
      changeFrequency: Number(r.get('changeFrequency')),
      authorCount: Number(r.get('authorCount')),
      throwsTypes: (r.get('throwsTypes') as string[]) ?? [],
      externalServices: (r.get('externalServices') as string[]) ?? [],
      testCoverage: Boolean(r.get('testCoverage')),
    }),
  );

  const result = rows[0] ?? null;
  ctx.logger.logCall('get_node', { symbolId }, result);
  return result;
}

/**
 * Returns the existing summary for a symbol, or null if none exists.
 */
export async function get_existing_summary(
  symbolId: string,
  ctx: SummarizationToolContext,
): Promise<ExistingSummary | null> {
  const { repo, filePath, name } = parseSymbolId(symbolId);
  const rows = await ctx.graph.runRead(
    `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})-[:HAS_SUMMARY]->(ss:SymbolSummary)
     RETURN
       ss.purpose AS purpose,
       ss.details AS details,
       ss.sideEffects AS sideEffects,
       coalesce(ss.semanticTags, []) AS semanticTags,
       ss.tier AS tier,
       coalesce(ss.stale, false) AS isStale,
       ss.generatedAt AS generatedAt`,
    { repo, filePath, name },
    (r) => ({
      purpose: String(r.get('purpose') ?? ''),
      details: r.get('details') as string | null,
      sideEffects: r.get('sideEffects') as string | null,
      semanticTags: (r.get('semanticTags') as string[]) ?? [],
      tier: String(r.get('tier') ?? 'provisional') as 'provisional' | 'canonical',
      isStale: Boolean(r.get('isStale')),
      generatedAt: String(r.get('generatedAt') ?? ''),
    }),
  );

  const result = rows[0] ?? null;
  ctx.logger.logCall('get_existing_summary', { symbolId }, result);
  return result;
}

/**
 * Returns callers of the given symbol up to `depth` hops.
 */
export async function expand_callers(
  symbolId: string,
  ctx: SummarizationToolContext,
  depth = 1,
  crossCommunityOnly = false,
): Promise<SymbolStub[]> {
  const { repo, filePath, name } = parseSymbolId(symbolId);
  const communityFilter = crossCommunityOnly
    ? 'AND (caller.communityId IS NULL OR caller.communityId <> coalesce(s.communityId, -999))'
    : '';
  const rows = await ctx.graph.runRead(
    `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
     MATCH (caller:Symbol)-[:CALLS*1..${depth}]->(s)
     WHERE true ${communityFilter}
     RETURN DISTINCT
       caller.repo + ':' + caller.filePath + '#' + caller.name AS symbolId,
       caller.name AS name,
       caller.kind AS kind,
       coalesce(caller.communityRole, 'core') AS communityRole,
       coalesce(caller.pageRank, 0.0) AS pageRank,
       coalesce(caller.fanIn, 0) AS fanIn,
       coalesce(caller.isPublicApi, false) AS isPublicApi,
       caller.docstring AS docstring,
       exists { MATCH (caller)-[:HAS_SUMMARY]->(:SymbolSummary) } AS hasSummary,
       [(caller)-[:HAS_SUMMARY]->(ss:SymbolSummary) | ss.tier][0] AS summaryTier
     ORDER BY coalesce(caller.pageRank, 0.0) DESC
     LIMIT 20`,
    { repo, filePath, name },
    (r) => toSymbolStub(r),
  );
  ctx.logger.logCall('expand_callers', { symbolId, depth, crossCommunityOnly }, rows);
  return rows;
}

/**
 * Returns callees of the given symbol up to `depth` hops.
 */
export async function expand_callees(
  symbolId: string,
  ctx: SummarizationToolContext,
  depth = 1,
  crossCommunityOnly = false,
): Promise<SymbolStub[]> {
  const { repo, filePath, name } = parseSymbolId(symbolId);
  const communityFilter = crossCommunityOnly
    ? 'AND (callee.communityId IS NULL OR callee.communityId <> coalesce(s.communityId, -999))'
    : '';
  const rows = await ctx.graph.runRead(
    `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
     MATCH (s)-[:CALLS*1..${depth}]->(callee:Symbol)
     WHERE true ${communityFilter}
     RETURN DISTINCT
       callee.repo + ':' + callee.filePath + '#' + callee.name AS symbolId,
       callee.name AS name,
       callee.kind AS kind,
       coalesce(callee.communityRole, 'core') AS communityRole,
       coalesce(callee.pageRank, 0.0) AS pageRank,
       coalesce(callee.fanIn, 0) AS fanIn,
       coalesce(callee.isPublicApi, false) AS isPublicApi,
       callee.docstring AS docstring,
       exists { MATCH (callee)-[:HAS_SUMMARY]->(:SymbolSummary) } AS hasSummary,
       [(callee)-[:HAS_SUMMARY]->(ss:SymbolSummary) | ss.tier][0] AS summaryTier
     ORDER BY coalesce(callee.pageRank, 0.0) DESC
     LIMIT 20`,
    { repo, filePath, name },
    (r) => toSymbolStub(r),
  );
  ctx.logger.logCall('expand_callees', { symbolId, depth, crossCommunityOnly }, rows);
  return rows;
}

/**
 * Returns raw source text for `filePath` lines `lineStart`–`lineEnd` (1-indexed,
 * inclusive). Range is capped at MAX_FILE_READ_LINES.
 */
export async function read_file_range(
  repo: string,
  filePath: string,
  lineStart: number,
  lineEnd: number,
  ctx: SummarizationToolContext,
): Promise<string> {
  const clampedEnd = Math.min(lineEnd, lineStart + MAX_FILE_READ_LINES - 1);
  const result = await ctx.sourceAccess.readFile(repo, filePath, {
    startLine: lineStart,
    endLine: clampedEnd,
  });
  ctx.logger.logCall('read_file_range', { repo, filePath, lineStart, lineEnd: clampedEnd }, {
    lineCount: result.split('\n').length,
  });
  return result;
}

/**
 * Validates payload assertions against the graph, writes the summary node, and
 * returns the validation result.
 */
export async function write_summary(
  target: SummaryTarget,
  payload: SummaryPayload,
  ctx: SummarizationToolContext,
): Promise<WriteSummaryResult> {
  const validation = await validateAssertions(target, payload.assertions ?? {}, ctx);

  await (target.kind === 'symbol' ? writeSymbolSummary(target.symbolId, payload, validation.status, ctx) : writeCommunitySummary(target.communityId, target.repo, payload, ctx));

  ctx.logger.logCall('write_summary', { target, tier: payload.tier }, { validation });
  return { validation };
}

/**
 * Records that the agent has finished processing a community cluster.
 */
export async function mark_cluster_complete(
  communityId: number,
  repo: string,
  coveragePct: number,
  ctx: SummarizationToolContext,
): Promise<void> {
  const actualPct = await computeActualCoverage(communityId, repo, ctx);
  const recorded = Math.min(coveragePct, actualPct);

  await ctx.graph.runWrite(
    `MATCH (c:Community {communityId: $communityId, repo: $repo})
     SET c.lastSummarizedAt = datetime(), c.coveragePct = $coveragePct`,
    { communityId, repo, coveragePct: recorded },
  );

  ctx.logger.logCall('mark_cluster_complete', { communityId, repo, coveragePct }, {
    recordedCoveragePct: recorded,
  });
}

/**
 * Returns communities that are unsummarized or stale, sorted by priority score.
 */
export async function list_pending_communities(
  repo: string,
  ctx: SummarizationToolContext,
): Promise<CommunityStub[]> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await ctx.graph.runRead(
    `MATCH (c:Community {repo: $repo})
     OPTIONAL MATCH (c)-[:HAS_COMMUNITY_SUMMARY]->(cs:CommunitySummary)
     WITH c, cs
     WHERE cs IS NULL OR cs.stale = true OR cs.generatedAt < $cutoff
     OPTIONAL MATCH (s:Symbol)-[:MEMBER_OF]->(c)
     WITH c, cs,
          avg(coalesce(s.pageRank, 0.0)) AS avgPageRank,
          avg(coalesce(s.fanIn, 0.0)) AS avgFanIn,
          avg(CASE WHEN s.isPublicApi THEN 1.0 ELSE 0.0 END) AS publicApiFraction,
          avg(coalesce(s.changeFrequency, 0.0)) AS avgChangeFrequency,
          avg(CASE WHEN exists { MATCH (s)-[:HAS_SUMMARY]->(ss:SymbolSummary {tier: 'canonical'}) } THEN 1.0 ELSE 0.0 END) AS canonicalFraction
     RETURN
       c.communityId AS communityId,
       c.size AS size,
       (0.4 * avgPageRank + 0.3 * avgFanIn + 0.2 * publicApiFraction + 0.1 * avgChangeFrequency - 1.0 * canonicalFraction) AS priorityScore,
       cs IS NOT NULL AS hasSummary,
       CASE WHEN cs IS NOT NULL THEN duration.between(datetime(cs.generatedAt), datetime()).days ELSE null END AS summaryAge
     ORDER BY priorityScore DESC`,
    { repo, cutoff },
    (r) => ({
      communityId: Number(r.get('communityId')),
      size: Number(r.get('size') ?? 0),
      priorityScore: Number(r.get('priorityScore') ?? 0),
      hasSummary: Boolean(r.get('hasSummary')),
      summaryAge: r.get('summaryAge') == null ? null : Number(r.get('summaryAge')),
    }),
  );
  ctx.logger.logCall('list_pending_communities', { repo }, { count: rows.length });
  return rows;
}

/**
 * Returns current coverage statistics for the repo.
 */
export async function get_coverage_report(
  repo: string,
  ctx: SummarizationToolContext,
): Promise<CoverageReport> {
  const [symbolRows, communityRows] = await Promise.all([
    ctx.graph.runRead(
      `MATCH (s:Symbol {repo: $repo})
       RETURN
         count(s) AS totalSymbols,
         count { MATCH (s)-[:HAS_SUMMARY]->(ss:SymbolSummary {tier: 'canonical'}) } AS withCanonical,
         count { MATCH (s)-[:HAS_SUMMARY]->(ss:SymbolSummary {tier: 'provisional'}) } AS withProvisional,
         count { MATCH (s)-[:HAS_SUMMARY]->(ss:SymbolSummary {stale: true, tier: 'canonical'}) } AS staleCanonical`,
      { repo },
      (r) => ({
        totalSymbols: Number(r.get('totalSymbols')),
        withCanonical: Number(r.get('withCanonical')),
        withProvisional: Number(r.get('withProvisional')),
        staleCanonical: Number(r.get('staleCanonical')),
      }),
    ),
    ctx.graph.runRead(
      `MATCH (c:Community {repo: $repo})
       RETURN
         count(c) AS totalCommunities,
         count { MATCH (c)-[:HAS_COMMUNITY_SUMMARY]->(:CommunitySummary) } AS withSummary`,
      { repo },
      (r) => ({
        totalCommunities: Number(r.get('totalCommunities')),
        withSummary: Number(r.get('withSummary')),
      }),
    ),
  ]);

  const sym = symbolRows[0] ?? { totalSymbols: 0, withCanonical: 0, withProvisional: 0, staleCanonical: 0 };
  const com = communityRows[0] ?? { totalCommunities: 0, withSummary: 0 };

  const unsummarized = sym.totalSymbols - sym.withCanonical - sym.withProvisional;
  // Rough cost estimate: ~$0.003 per symbol for canonical, ~$0.0003 for provisional
  const estimatedCostToComplete = unsummarized * 0.003 + sym.withProvisional * 0.0025;

  const report: CoverageReport = {
    totalSymbols: sym.totalSymbols,
    symbolsWithCanonical: sym.withCanonical,
    symbolsWithProvisional: sym.withProvisional,
    symbolsUnsummarized: Math.max(0, unsummarized),
    staleCanonical: sym.staleCanonical,
    totalCommunities: com.totalCommunities,
    communitiesWithSummary: com.withSummary,
    estimatedCostToComplete,
  };
  ctx.logger.logCall('get_coverage_report', { repo }, report);
  return report;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseSymbolId(symbolId: string): { repo: string; filePath: string; name: string } {
  const hashIdx = symbolId.lastIndexOf('#');
  if (hashIdx === -1) throw new Error(`Invalid symbolId (missing '#'): ${symbolId}`);
  const head = symbolId.slice(0, hashIdx);
  const name = symbolId.slice(hashIdx + 1);
  const colonIdx = head.indexOf(':');
  if (colonIdx === -1) throw new Error(`Invalid symbolId (missing ':'): ${symbolId}`);
  return { repo: head.slice(0, colonIdx), filePath: head.slice(colonIdx + 1), name };
}

function toSymbolStub(r: import('neo4j-driver').Record): SymbolStub {
  return {
    symbolId: String(r.get('symbolId')),
    name: String(r.get('name')),
    kind: String(r.get('kind') ?? 'unknown'),
    communityRole: String(r.get('communityRole') ?? 'core'),
    pageRank: Number(r.get('pageRank') ?? 0),
    fanIn: Number(r.get('fanIn') ?? 0),
    isPublicApi: Boolean(r.get('isPublicApi')),
    docstring: r.get('docstring') as string | null,
    hasSummary: Boolean(r.get('hasSummary')),
    summaryTier: (r.get('summaryTier') as 'provisional' | 'canonical' | null) ?? null,
  };
}

async function validateAssertions(
  target: SummaryTarget,
  assertions: SummaryAssertions,
  ctx: SummarizationToolContext,
): Promise<ValidationResult> {
  if (target.kind !== 'symbol') return { status: 'unvalidated', failedAssertions: [] };
  const { repo, filePath, name } = parseSymbolId(target.symbolId);
  const failed: string[] = [];

  if (assertions.calls && assertions.calls.length > 0) {
    for (const calleeName of assertions.calls.slice(0, 10)) {
      const rows = await ctx.graph.runRead(
        `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})-[:CALLS]->(t:Symbol {name: $callee})
         RETURN count(t) AS n`,
        { repo, filePath, name, callee: calleeName },
        (r) => Number(r.get('n')),
      );
      if (!rows[0]) failed.push(`calls:${calleeName}`);
    }
  }

  if (assertions.throws && assertions.throws.length > 0) {
    for (const errorType of assertions.throws.slice(0, 10)) {
      const rows = await ctx.graph.runRead(
        `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})-[:THROWS]->(e {name: $errorType})
         RETURN count(e) AS n`,
        { repo, filePath, name, errorType },
        (r) => Number(r.get('n')),
      );
      if (!rows[0]) failed.push(`throws:${errorType}`);
    }
  }

  if (assertions.reads_config && assertions.reads_config.length > 0) {
    for (const key of assertions.reads_config.slice(0, 10)) {
      const rows = await ctx.graph.runRead(
        `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
         WHERE $key IN coalesce(s.configKeysRead, [])
            OR exists { MATCH (s)-[:READS_CONFIG]->({name: $key}) }
         RETURN count(s) AS n`,
        { repo, filePath, name, key },
        (r) => Number(r.get('n')),
      );
      if (!rows[0]) failed.push(`reads_config:${key}`);
    }
  }

  const status: ValidationStatus =
    failed.length === 0
      ? 'validated'
      : failed.length < (assertions.calls ?? []).length +
          (assertions.throws ?? []).length +
          (assertions.reads_config ?? []).length
        ? 'partial'
        : 'unvalidated';

  return { status, failedAssertions: failed };
}

async function writeSymbolSummary(
  symbolId: string,
  payload: SummaryPayload,
  validationStatus: ValidationStatus,
  ctx: SummarizationToolContext,
): Promise<void> {
  const { repo, filePath, name } = parseSymbolId(symbolId);
  await ctx.graph.runWrite(
    `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
     OPTIONAL MATCH (s)-[old:HAS_SUMMARY]->(prev:SymbolSummary)
     DELETE old, prev
     WITH s
     CREATE (ss:SymbolSummary {
       symbolFqn:         $symbolId,
       purpose:           $purpose,
       details:           $details,
       sideEffects:       $sideEffects,
       semanticTags:      $semanticTags,
       examplesFromTests: $examplesFromTests,
       tier:              $tier,
       model:             $model,
       generatedAt:       datetime(),
       contentHash:       coalesce(s.hash, ''),
       coverageFlags:     $coverageFlags,
       validationStatus:  $validationStatus,
       stale:             false
     })
     MERGE (s)-[:HAS_SUMMARY]->(ss)`,
    {
      repo,
      filePath,
      name,
      symbolId,
      purpose: payload.purpose.slice(0, 150),
      details: payload.details ?? null,
      sideEffects: payload.sideEffects ?? null,
      semanticTags: payload.semanticTags.slice(0, 10),
      examplesFromTests: payload.examplesFromTests ?? null,
      tier: payload.tier,
      model: 'kepler-summarization',
      coverageFlags: payload.coverageFlags,
      validationStatus,
    },
  );
}

async function writeCommunitySummary(
  communityId: number,
  repo: string,
  payload: SummaryPayload,
  ctx: SummarizationToolContext,
): Promise<void> {
  await ctx.graph.runWrite(
    `MATCH (c:Community {communityId: $communityId, repo: $repo})
     OPTIONAL MATCH (c)-[old:HAS_COMMUNITY_SUMMARY]->(prev:CommunitySummary)
     DELETE old, prev
     WITH c
     CREATE (cs:CommunitySummary {
       communityId:          $communityId,
       repo:                 $repo,
       name:                 $name,
       purpose:              $purpose,
       keySymbols:           [],
       externalDependencies: $externalDependencies,
       tier:                 $tier,
       model:                'kepler-summarization',
       generatedAt:          datetime(),
       symbolCount:          0,
       coveragePct:          0.0,
       stale:                false
     })
     MERGE (c)-[:HAS_COMMUNITY_SUMMARY]->(cs)`,
    {
      communityId,
      repo,
      name: payload.name ?? `Community ${communityId}`,
      purpose: payload.purpose,
      externalDependencies: payload.externalDependencies ?? [],
      tier: payload.tier,
    },
  );
}

async function computeActualCoverage(
  communityId: number,
  repo: string,
  ctx: SummarizationToolContext,
): Promise<number> {
  const rows = await ctx.graph.runRead(
    `MATCH (s:Symbol)-[:MEMBER_OF]->(c:Community {communityId: $communityId, repo: $repo})
     RETURN
       count(s) AS total,
       count { MATCH (s)-[:HAS_SUMMARY]->(:SymbolSummary) } AS summarized`,
    { communityId, repo },
    (r) => ({
      total: Number(r.get('total')),
      summarized: Number(r.get('summarized')),
    }),
  );
  const row = rows[0];
  if (!row || row.total === 0) return 0;
  return row.summarized / row.total;
}
