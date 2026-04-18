import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse, textResponse } from '../types.js';

export async function graphSymbolsInDoc(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const path = params['path'] as string | undefined;

  if (!path) return errorResponse('Missing required parameter: path');

  const cypher = `
    MATCH (d:Document {path: $path})
    OPTIONAL MATCH (d)-[:GOVERNS]->(s:Symbol)
    OPTIONAL MATCH (s2:Symbol)-[:DOCUMENTED_BY]->(d)
    WITH d, collect(DISTINCT {
      id: s.id, name: s.name, kind: s.kind,
      repo: s.repo, filePath: s.filePath, line: s.line,
      relationship: 'GOVERNS'
    }) AS governed,
    collect(DISTINCT {
      id: s2.id, name: s2.name, kind: s2.kind,
      repo: s2.repo, filePath: s2.filePath, line: s2.line,
      relationship: 'DOCUMENTED_BY'
    }) AS documentedBy
    RETURN d.path AS docPath,
           [x IN governed WHERE x.id IS NOT NULL] AS governedSymbols,
           [x IN documentedBy WHERE x.id IS NOT NULL] AS documentedBySymbols
  `;

  const rows = await ctx.graph.runRead(cypher, { path }, (r) => ({
    docPath: r.get('docPath'),
    governedSymbols: r.get('governedSymbols'),
    documentedBySymbols: r.get('documentedBySymbols'),
  }));

  if (rows.length === 0 || !rows[0]) {
    return textResponse(`No document found at path "${path}".`);
  }

  const result = rows[0];
  const total =
    (result.governedSymbols as unknown[]).length +
    (result.documentedBySymbols as unknown[]).length;
  return structuredResponse(result, `Found ${total} symbol(s) referenced by "${path}".`);
}
