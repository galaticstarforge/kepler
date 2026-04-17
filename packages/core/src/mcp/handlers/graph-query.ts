import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

export async function graphQuery(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const cypher = params['cypher'] as string | undefined;
  const queryParams = (params['params'] as Record<string, unknown>) ?? {};

  if (!cypher) return errorResponse('Missing required parameter: cypher');

  const records = await ctx.graph.runRead(cypher, queryParams, (r) => r.toObject());
  return structuredResponse(records, `Query returned ${records.length} record(s).`);
}
