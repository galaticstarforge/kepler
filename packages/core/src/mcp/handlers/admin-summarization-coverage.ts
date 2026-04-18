import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

export async function adminSummarizationCoverage(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = typeof params['repo'] === 'string' ? params['repo'] : '';
  if (!repo) {
    return errorResponse('`repo` parameter is required.');
  }

  // Coverage query from the graph.
  let symbolRows: {
    totalSymbols: number;
    withCanonical: number;
    withProvisional: number;
    staleCanonical: number;
  }[];
  let communityRows: { totalCommunities: number; withSummary: number }[];

  try {
    [symbolRows, communityRows] = await Promise.all([
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
  } catch (error) {
    return errorResponse(`Graph query failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sym = symbolRows[0] ?? { totalSymbols: 0, withCanonical: 0, withProvisional: 0, staleCanonical: 0 };
  const com = communityRows[0] ?? { totalCommunities: 0, withSummary: 0 };

  const unsummarized = Math.max(0, sym.totalSymbols - sym.withCanonical - sym.withProvisional);
  const canonicalPct =
    sym.totalSymbols > 0 ? (sym.withCanonical / sym.totalSymbols) * 100 : 0;
  const provisionalPct =
    sym.totalSymbols > 0 ? (sym.withProvisional / sym.totalSymbols) * 100 : 0;
  const unsummarizedPct =
    sym.totalSymbols > 0 ? (unsummarized / sym.totalSymbols) * 100 : 0;

  // Pull live gauge values from the agent if available.
  const gauges = ctx.summarizationAgent?.gauges ?? null;

  const lastRun = ctx.summarizationAgent?.getLastRun();
  const estimatedCostToComplete = unsummarized * 0.003 + sym.withProvisional * 0.0025;

  const report = {
    repo,
    symbols: {
      total: sym.totalSymbols,
      canonical: sym.withCanonical,
      provisional: sym.withProvisional,
      unsummarized,
      staleCanonical: sym.staleCanonical,
    },
    pct: {
      canonical: Number(canonicalPct.toFixed(1)),
      provisional: Number(provisionalPct.toFixed(1)),
      unsummarized: Number(unsummarizedPct.toFixed(1)),
    },
    communities: {
      total: com.totalCommunities,
      withSummary: com.withSummary,
    },
    estimatedCostToComplete: Number(estimatedCostToComplete.toFixed(4)),
    lastRunCostUSD: gauges ? Number(gauges.lastRunCostUSD.toFixed(4)) : null,
    lastRun: lastRun
      ? {
          runId: lastRun.runId,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          endedAt: lastRun.endedAt,
          stats: lastRun.stats,
        }
      : null,
  };

  const summary =
    `Summarization coverage for ${repo}: ` +
    `${canonicalPct.toFixed(1)}% canonical, ` +
    `${provisionalPct.toFixed(1)}% provisional, ` +
    `${unsummarizedPct.toFixed(1)}% unsummarized.`;

  return structuredResponse(report, summary);
}
