import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

export async function adminEnrichmentRun(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const opts: { pathPrefix?: string } = {};
  const pathPrefix = params['pathPrefix'];
  if (typeof pathPrefix === 'string') opts.pathPrefix = pathPrefix;

  try {
    const record = await ctx.enrichmentRunner.start(opts);
    return structuredResponse(
      { runId: record.runId, status: record.status, startedAt: record.startedAt },
      `Enrichment run ${record.runId} started. Poll admin.enrichmentStatus for progress.`,
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(msg);
  }
}
