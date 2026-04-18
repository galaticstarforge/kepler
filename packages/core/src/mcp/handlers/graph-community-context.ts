import { VECTOR_INDEX_NAMES } from '../../graph/schema.js';
import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function graphCommunityContext(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const communityId = params['communityId'];
  const name = params['name'] as string | undefined;
  const queryVector = params['queryVector'];

  if (communityId == null && !name && !queryVector) {
    return errorResponse('Provide communityId, name, or queryVector to identify the community.');
  }

  let resolvedId: number | null = null;

  if (communityId != null) {
    resolvedId = typeof communityId === 'number' ? communityId : Number(communityId);
  } else if (queryVector && Array.isArray(queryVector) && queryVector.length > 0) {
    // Vector search for closest community by name embedding.
    const hitRows = await ctx.graph.runRead(
      `CALL db.index.vector.queryNodes($indexName, 1, $vector)
       YIELD node, score
       WHERE node:CommunitySummary
       RETURN node.communityId AS communityId LIMIT 1`,
      { indexName: VECTOR_INDEX_NAMES.communitySummary, vector: queryVector as number[] },
      (r) => r.get('communityId') as number,
    );
    if (hitRows.length > 0) resolvedId = hitRows[0] ?? null;
  }

  // If name provided (and no vector search), do a simple string match on CommunitySummary name.
  if (resolvedId == null && name) {
    const nameRows = await ctx.graph.runRead(
      `MATCH (cs:CommunitySummary) WHERE cs.name CONTAINS $name RETURN cs.communityId AS communityId LIMIT 1`,
      { name },
      (r) => r.get('communityId') as number,
    );
    if (nameRows.length > 0) resolvedId = nameRows[0] ?? null;
  }

  if (resolvedId == null) {
    return textResponse('No matching community found.');
  }

  const cypher = `
    MATCH (c:Community {communityId: $communityId})
    OPTIONAL MATCH (cs:CommunitySummary {communityId: $communityId})
    WITH c, cs
    MATCH (s:Symbol) WHERE s.communityId = $communityId
    WITH c, cs, s ORDER BY coalesce(s.pageRank, 0) DESC
    WITH c, cs, collect(s)[..10] AS topSymbols
    UNWIND topSymbols AS sym
    OPTIONAL MATCH (ss:SymbolSummary {symbolId: sym.id})
    RETURN c.communityId AS communityId, c.repo AS repo,
           cs { .name, .purpose, .tags, .tier } AS communitySummary,
           collect({
             id: sym.id, name: sym.name, kind: sym.kind,
             isPublicApi: sym.isPublicApi, pageRank: sym.pageRank,
             summary: ss { .purpose, .tier }
           }) AS topSymbols
  `;

  const rows = await ctx.graph.runRead(cypher, { communityId: resolvedId }, (r) => ({
    communityId: r.get('communityId'),
    repo: r.get('repo'),
    communitySummary: r.get('communitySummary'),
    topSymbols: r.get('topSymbols'),
  }));

  if (rows.length === 0 || !rows[0]) {
    return textResponse(`No data found for communityId ${resolvedId}.`);
  }

  const result = rows[0];
  return structuredResponse(
    result,
    `Community ${resolvedId} context: ${(result.topSymbols as unknown[]).length} top symbol(s).`,
  );
}
