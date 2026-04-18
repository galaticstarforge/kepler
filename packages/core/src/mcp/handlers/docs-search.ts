import type { SearchOptions } from '@keplerforge/shared';
import { CONCEPTS_PREFIX, SCRATCHPAD_PREFIX } from '@keplerforge/shared';

import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse, textResponse } from '../types.js';

export async function docsSearch(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const query = params['query'] as string | undefined;
  if (!query) return textResponse('Missing required parameter: query');

  const options: SearchOptions = {};
  if (typeof params['limit'] === 'number') options.limit = params['limit'];
  if (typeof params['minScore'] === 'number') options.minScore = params['minScore'];
  if (params['filter'] && typeof params['filter'] === 'object') {
    options.filter = params['filter'] as Record<string, string>;
  }

  const raw = await ctx.index.search(query, options);
  const results = raw.filter(
    (r) => !r.path.startsWith(CONCEPTS_PREFIX) && !r.path.startsWith(SCRATCHPAD_PREFIX),
  );

  if (results.length === 0) {
    return textResponse('No documents matched your search query.');
  }

  return structuredResponse(results, `Found ${results.length} result(s).`);
}
