import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, textResponse } from '../types.js';

export async function docsDelete(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const docPath = params['path'] as string | undefined;
  if (!docPath) return errorResponse('Missing required parameter: path');

  await ctx.store.delete(docPath);
  await ctx.index.delete(docPath);

  return textResponse(`Deleted document at "${docPath}".`);
}
