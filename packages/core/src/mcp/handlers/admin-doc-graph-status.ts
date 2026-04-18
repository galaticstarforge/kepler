import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function adminDocGraphStatus(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  if (!ctx.docGraphReconciler) {
    return errorResponse('Doc-graph reconciler is not configured.');
  }

  const runId = params['runId'];
  if (typeof runId !== 'string' || !runId) {
    return textResponse('Missing required parameter: runId');
  }

  const record = await ctx.docGraphReconciler.getRunRecord(runId);
  if (!record) {
    return textResponse(`No doc-graph run found with id "${runId}".`);
  }

  return structuredResponse(record, `Doc-graph run ${runId} is ${record.status}.`);
}
