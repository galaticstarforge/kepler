import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse, textResponse } from '../types.js';

export async function conceptsRead(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const id = params['id'];
  if (typeof id !== 'string' || !id) {
    return textResponse('Missing required parameter: id');
  }

  const concept = await ctx.conceptStore.get(id);
  if (!concept) {
    return textResponse(`Concept "${id}" not found.`);
  }

  // Strip the (large) embedding from the response payload — clients rarely need it.
  const { embeddingB64, ...rest } = concept;
  void embeddingB64;
  return structuredResponse(
    rest,
    `Concept "${concept.name}" has ${concept.mentions.length} mention(s).`,
  );
}
