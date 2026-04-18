import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;

export async function graphCallees(
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

  const matchClause = id
    ? 'MATCH (target:Symbol {id: $ref})'
    : 'MATCH (target:Symbol) WHERE target.name = $ref';
  const ref = id ?? qualifiedName;

  const cypher = `
    ${matchClause}
    CALL apoc.path.subgraphNodes(target, {
      relationshipFilter: '>CALLS',
      maxLevel: $depth,
      labelFilter: '+Symbol'
    })
    YIELD node AS callee
    WHERE callee <> target
    RETURN callee.id AS id, callee.name AS name, callee.kind AS kind,
           callee.repo AS repo, callee.filePath AS filePath, callee.line AS line
    ORDER BY callee.name
  `;

  try {
    const rows = await ctx.graph.runRead(cypher, { ref, depth }, (r) => ({
      id: r.get('id'),
      name: r.get('name'),
      kind: r.get('kind'),
      repo: r.get('repo'),
      filePath: r.get('filePath'),
      line: r.get('line'),
    }));
    return structuredResponse(
      { callees: rows, depth },
      `Found ${rows.length} callee(s) (up to depth ${depth}).`,
    );
  } catch {
    // Fallback without APOC: single-hop callees.
    const fallbackCypher = `
      MATCH (target:Symbol) WHERE ${id ? 'target.id = $ref' : 'target.name = $ref'}
      MATCH (target)-[:CALLS]->(callee:Symbol)
      RETURN callee.id AS id, callee.name AS name, callee.kind AS kind,
             callee.repo AS repo, callee.filePath AS filePath, callee.line AS line
      ORDER BY callee.name
    `;
    const rows = await ctx.graph.runRead(fallbackCypher, { ref }, (r) => ({
      id: r.get('id'),
      name: r.get('name'),
      kind: r.get('kind'),
      repo: r.get('repo'),
      filePath: r.get('filePath'),
      line: r.get('line'),
    }));
    return structuredResponse(
      { callees: rows, depth: 1, note: 'APOC not available; returned single-hop callees only.' },
      `Found ${rows.length} direct callee(s).`,
    );
  }
}
