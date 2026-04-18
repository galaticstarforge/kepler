import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function graphRelatedDocs(
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

  // Find documents linked via DOCUMENTED_BY or GOVERNS edges.
  const cypher = `
    MATCH (s:Symbol) WHERE ${whereClause}
    OPTIONAL MATCH (s)-[:DOCUMENTED_BY]->(d1:Document)
    OPTIONAL MATCH (d2:Document)-[:GOVERNS]->(s)
    WITH s, collect(DISTINCT {path: d1.path, type: d1.type, title: d1.title, relationship: 'DOCUMENTED_BY'}) AS docBy,
            collect(DISTINCT {path: d2.path, type: d2.type, title: d2.title, relationship: 'GOVERNS'}) AS govBy
    RETURN s.id AS symbolId, s.name AS symbolName,
           [x IN docBy WHERE x.path IS NOT NULL] AS documentedBy,
           [x IN govBy WHERE x.path IS NOT NULL] AS governedBy
  `;

  const rows = await ctx.graph.runRead(cypher, { ref }, (r) => ({
    symbolId: r.get('symbolId'),
    symbolName: r.get('symbolName'),
    documentedBy: r.get('documentedBy'),
    governedBy: r.get('governedBy'),
  }));

  if (rows.length === 0 || !rows[0]) {
    return textResponse(`No symbol found with ${id ? `id "${id}"` : `name "${qualifiedName}"`}.`);
  }

  const result = rows[0];
  const total =
    (result.documentedBy as unknown[]).length + (result.governedBy as unknown[]).length;
  return structuredResponse(result, `Found ${total} related document(s) for "${result.symbolName}".`);
}
