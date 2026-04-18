import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function graphSymbolContext(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const id = params['id'] as string | undefined;
  const qualifiedName = params['qualifiedName'] as string | undefined;

  if (!id && !qualifiedName) {
    return errorResponse('Missing required parameter: id or qualifiedName');
  }

  const whereClause = id ? 's.id = $ref' : 's.name = $ref';
  const ref = id ?? qualifiedName;

  const cypher = `
    MATCH (s:Symbol) WHERE ${whereClause}
    OPTIONAL MATCH (ss:SymbolSummary {symbolId: s.id})
    OPTIONAL MATCH (s)-[:IN_LAYER]->(al:ArchitecturalLayer)
    OPTIONAL MATCH (s)-[:IN_CONTEXT]->(bc:BoundedContext)
    OPTIONAL MATCH (s)-[:IN_COMMUNITY]->(comm:Community)
    WITH s, ss, al, bc, comm
    OPTIONAL MATCH (caller:Symbol)-[:CALLS]->(s)
    WITH s, ss, al, bc, comm, collect(DISTINCT {
      id: caller.id, name: caller.name, kind: caller.kind,
      filePath: caller.filePath, line: caller.line
    })[..5] AS topCallers
    OPTIONAL MATCH (s)-[:CALLS]->(callee:Symbol)
    WITH s, ss, al, bc, comm, topCallers, collect(DISTINCT {
      id: callee.id, name: callee.name, kind: callee.kind,
      filePath: callee.filePath, line: callee.line
    })[..5] AS topCallees
    OPTIONAL MATCH (s)-[:DOCUMENTED_BY]->(d:Document)
    RETURN s {
      .id, .name, .kind, .repo, .filePath, .line,
      .isPublicApi, .pageRank, .communityId, .volatility
    } AS symbol,
    ss { .purpose, .tags, .tier, .validationStatus } AS summary,
    al.name AS layer,
    bc.name AS boundedContext,
    comm.communityId AS communityId,
    topCallers,
    topCallees,
    collect(DISTINCT d.path) AS relatedDocs
  `;

  const rows = await ctx.graph.runRead(cypher, { ref }, (r) => ({
    symbol: r.get('symbol'),
    summary: r.get('summary'),
    layer: r.get('layer'),
    boundedContext: r.get('boundedContext'),
    communityId: r.get('communityId'),
    topCallers: r.get('topCallers'),
    topCallees: r.get('topCallees'),
    relatedDocs: r.get('relatedDocs'),
  }));

  if (rows.length === 0 || !rows[0]) {
    return textResponse(`No symbol found with ${id ? `id "${id}"` : `name "${qualifiedName}"`}.`);
  }

  const result = rows[0];
  const summaryAvailable = result.summary != null;
  return structuredResponse(
    { ...result, summaryAvailable },
    `Context pack for "${(result.symbol as Record<string, unknown>)?.name}". Summary: ${summaryAvailable ? (result.summary as Record<string, unknown>)?.tier : 'not available'}.`,
  );
}
