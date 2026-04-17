import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, textResponse } from '../types.js';

export async function docsRead(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const docPath = params['path'] as string | undefined;
  if (!docPath) return errorResponse('Missing required parameter: path');

  const doc = await ctx.store.get(docPath);
  if (!doc) return errorResponse(`Document not found: "${docPath}".`);

  return textResponse(doc.content.toString('utf8'));
}
