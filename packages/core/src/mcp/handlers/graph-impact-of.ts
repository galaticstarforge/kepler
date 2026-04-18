import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;

export async function graphImpactOf(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const id = params['id'] as string | undefined;
  const qualifiedName = params['qualifiedName'] as string | undefined;
  const depthRaw = typeof params['depth'] === 'number' ? params['depth'] : DEFAULT_DEPTH;
  const depth = Math.min(Math.max(1, Math.floor(depthRaw)), MAX_DEPTH);

  if (!id && !qualifiedName) {
    return errorResponse('Missing required parameter: id or qualifiedName');
  }

  const ref = id ?? qualifiedName;
  const whereClause = id ? 'origin.id = $ref' : 'origin.name = $ref';

  // Transitive callers (who calls this?) + transitive THROWS propagation (who is affected?).
  const cypher = `
    MATCH (origin:Symbol) WHERE ${whereClause}
    OPTIONAL MATCH callPath = (caller:Symbol)-[:CALLS*1..${depth}]->(origin)
    WITH origin, collect(DISTINCT {
      id: caller.id, name: caller.name, kind: caller.kind,
      repo: caller.repo, filePath: caller.filePath, line: caller.line,
      relationship: 'CALLS'
    }) AS callerImpact
    OPTIONAL MATCH throwPath = (origin)-[:THROWS*1..${depth}]->(exception:Symbol)
    WITH origin, callerImpact, collect(DISTINCT {
      id: exception.id, name: exception.name, kind: exception.kind,
      repo: exception.repo, filePath: exception.filePath, line: exception.line,
      relationship: 'THROWS'
    }) AS throwImpact
    RETURN origin.id AS originId, origin.name AS originName,
           callerImpact, throwImpact
  `;

  const rows = await ctx.graph.runRead(cypher, { ref, depth }, (r) => ({
    originId: r.get('originId'),
    originName: r.get('originName'),
    callers: r.get('callerImpact'),
    thrownExceptions: r.get('throwImpact'),
  }));

  if (rows.length === 0 || !rows[0]) {
    return structuredResponse({ callers: [], thrownExceptions: [] }, 'Symbol not found.');
  }

  const result = rows[0];
  const totalImpacted =
    (result.callers as unknown[]).length + (result.thrownExceptions as unknown[]).length;
  return structuredResponse(
    result,
    `Impact analysis for "${result.originName}": ${totalImpacted} affected symbol(s) within depth ${depth}.`,
  );
}
