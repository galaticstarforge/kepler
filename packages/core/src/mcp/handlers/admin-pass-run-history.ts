import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function adminPassRunHistory(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = params['repo'] as string | undefined;
  const limitRaw = typeof params['limit'] === 'number' ? params['limit'] : 50;
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), 200);

  if (!repo) return errorResponse('Missing required parameter: repo');

  if (!ctx.passRunHistory) {
    return textResponse('Pass run history store is not configured.');
  }

  const records = await ctx.passRunHistory.list(repo, limit);
  return structuredResponse(
    { repo, records, count: records.length },
    `Retrieved ${records.length} pass run record(s) for repo "${repo}".`,
  );
}
