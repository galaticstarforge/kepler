import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;

export async function graphCallers(
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
      relationshipFilter: '<CALLS',
      maxLevel: $depth,
      labelFilter: '+Symbol'
    })
    YIELD node AS caller
    WHERE caller <> target
    RETURN caller.id AS id, caller.name AS name, caller.kind AS kind,
           caller.repo AS repo, caller.filePath AS filePath, caller.line AS line
    ORDER BY caller.name
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
      { callers: rows, depth },
      `Found ${rows.length} caller(s) (up to depth ${depth}).`,
    );
  } catch {
    // Fallback without APOC: single-hop callers.
    const fallbackCypher = `
      MATCH (target:Symbol) WHERE ${id ? 'target.id = $ref' : 'target.name = $ref'}
      MATCH (caller:Symbol)-[:CALLS]->(target)
      RETURN caller.id AS id, caller.name AS name, caller.kind AS kind,
             caller.repo AS repo, caller.filePath AS filePath, caller.line AS line
      ORDER BY caller.name
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
      { callers: rows, depth: 1, note: 'APOC not available; returned single-hop callers only.' },
      `Found ${rows.length} direct caller(s).`,
    );
  }
}
