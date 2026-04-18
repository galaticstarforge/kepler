import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

export async function graphFindSymbol(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const name = params['name'] as string | undefined;
  const kind = params['kind'] as string | undefined;
  const repo = params['repo'] as string | undefined;
  const filePath = params['filePath'] as string | undefined;
  const limit = Math.min(typeof params['limit'] === 'number' ? params['limit'] : 20, 100);

  if (!name) return errorResponse('Missing required parameter: name');

  const conditions: string[] = ['s.name CONTAINS $name'];
  const qp: Record<string, unknown> = { name, limit };

  if (kind) {
    conditions.push('s.kind = $kind');
    qp['kind'] = kind;
  }
  if (repo) {
    conditions.push('s.repo = $repo');
    qp['repo'] = repo;
  }
  if (filePath) {
    conditions.push('s.filePath CONTAINS $filePath');
    qp['filePath'] = filePath;
  }

  const cypher = `
    MATCH (s:Symbol)
    WHERE ${conditions.join(' AND ')}
    RETURN s.id AS id, s.name AS name, s.kind AS kind,
           s.repo AS repo, s.filePath AS filePath,
           s.line AS line, s.signature AS signature
    ORDER BY s.name
    LIMIT $limit
  `;

  const rows = await ctx.graph.runRead(cypher, qp, (r) => ({
    id: r.get('id'),
    name: r.get('name'),
    kind: r.get('kind'),
    repo: r.get('repo'),
    filePath: r.get('filePath'),
    line: r.get('line'),
    signature: r.get('signature'),
  }));

  return structuredResponse(rows, `Found ${rows.length} symbol(s) matching "${name}".`);
}
