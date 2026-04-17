import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function conceptsList(
  _params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const items: Array<{ id: string; name: string; mentionCount: number; updatedAt: string }> = [];
  for await (const concept of ctx.conceptStore.list()) {
    items.push({
      id: concept.id,
      name: concept.name,
      mentionCount: concept.mentions.length,
      updatedAt: concept.updatedAt,
    });
  }

  return structuredResponse(items, `Found ${items.length} concept(s).`);
}
