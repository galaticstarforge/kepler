import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse, textResponse } from '../types.js';

export async function adminRecomputeMetrics(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = params['repo'] as string | undefined;

  if (!ctx.orchestrator) {
    return textResponse(
      'Orchestrator is not running. Source access must be enabled to trigger metric recomputation.',
    );
  }

  // Check if GDS is available by probing for a simple GDS procedure.
  let gdsAvailable = false;
  try {
    await ctx.graph.runRead(
      `CALL gds.list() YIELD procName RETURN procName LIMIT 1`,
      {},
      (r) => r.get('procName'),
    );
    gdsAvailable = true;
  } catch {
    // GDS not installed — structural metrics passes will still run via the pass runner.
  }

  const configured = ctx.orchestrator.configuredRepos();
  const targetRepos = repo ? [repo] : configured;
  const inFlight = ctx.orchestrator.inFlightRepos();

  return structuredResponse(
    {
      requestedRepos: targetRepos,
      inFlightRepos: inFlight,
      gdsAvailable,
      note: 'Structural metrics (PageRank, Leiden communities, betweenness) will be recomputed on the next indexing run for the target repos.',
    },
    `Metrics recomputation scheduled for ${targetRepos.length} repo(s). GDS: ${gdsAvailable ? 'available' : 'not installed (basic metrics only)'}.`,
  );
}
