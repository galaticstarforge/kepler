import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

export async function adminDocGraphRun(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  if (!ctx.docGraphReconciler) {
    return errorResponse('Doc-graph reconciler is not configured.');
  }

  const opts: { pathPrefix?: string } = {};
  if (typeof params['pathPrefix'] === 'string') opts.pathPrefix = params['pathPrefix'];

  try {
    const record = await ctx.docGraphReconciler.start(opts);
    return structuredResponse(
      { runId: record.runId, status: record.status, startedAt: record.startedAt },
      `Doc-graph run ${record.runId} started. Poll admin.docGraphStatus for progress.`,
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(msg);
  }
}
