import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function graphSymbolDetails(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const id = params['id'] as string | undefined;
  const qualifiedName = params['qualifiedName'] as string | undefined;

  if (!id && !qualifiedName) {
    return errorResponse('Missing required parameter: id or qualifiedName');
  }

  const matchClause = id
    ? 'MATCH (s:Symbol {id: $id})'
    : 'MATCH (s:Symbol) WHERE s.name = $qualifiedName';
  const qp: Record<string, unknown> = id ? { id } : { qualifiedName };

  const cypher = `
    ${matchClause}
    OPTIONAL MATCH (s)-[:MEMBER_OF]->(m:Module)
    OPTIONAL MATCH (s)-[:IN_LAYER]->(al:ArchitecturalLayer)
    OPTIONAL MATCH (s)-[:IN_CONTEXT]->(bc:BoundedContext)
    OPTIONAL MATCH (ss:SymbolSummary {symbolId: s.id})
    RETURN s {
      .id, .name, .kind, .repo, .filePath, .line, .signature,
      .isPublicApi, .pageRank, .betweenness, .communityId,
      .volatility, .contentHash
    } AS symbol,
    m.path AS modulePath,
    al.name AS layer,
    bc.name AS boundedContext,
    ss { .purpose, .tags, .tier, .validationStatus } AS summary
  `;

  const rows = await ctx.graph.runRead(cypher, qp, (r) => ({
    symbol: r.get('symbol'),
    modulePath: r.get('modulePath'),
    layer: r.get('layer'),
    boundedContext: r.get('boundedContext'),
    summary: r.get('summary'),
  }));

  if (rows.length === 0) {
    return textResponse(`No symbol found with ${id ? `id "${id}"` : `name "${qualifiedName}"`}.`);
  }

  return structuredResponse(rows[0], `Symbol details for ${rows[0]?.symbol?.name ?? id ?? qualifiedName}.`);
}
