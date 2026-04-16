import type { DocumentHead } from '@kepler/shared';

import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function docsList(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const prefix = (params['prefix'] as string | undefined) ?? '';

  const items: DocumentHead[] = [];
  for await (const head of ctx.store.list(prefix)) {
    items.push(head);
  }

  return structuredResponse(
    items.map((h) => ({
      path: h.path,
      contentType: h.metadata.contentType,
      contentLength: h.metadata.contentLength,
      lastModified: h.metadata.lastModified.toISOString(),
    })),
    `Found ${items.length} document(s) under "${prefix || '/'}".`,
  );
}
