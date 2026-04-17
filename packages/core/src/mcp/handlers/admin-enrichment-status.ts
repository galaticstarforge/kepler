import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse, textResponse } from '../types.js';

export async function adminEnrichmentStatus(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const runId = params['runId'];
  if (typeof runId !== 'string' || !runId) {
    return textResponse('Missing required parameter: runId');
  }

  const record = await ctx.conceptStore.getRun(runId);
  if (!record) {
    return textResponse(`No run found with id "${runId}".`);
  }

  return structuredResponse(record, `Run ${runId} is ${record.status}.`);
}
