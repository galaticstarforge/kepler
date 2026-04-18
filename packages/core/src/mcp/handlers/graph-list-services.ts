import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function graphListServices(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = params['repo'] as string | undefined;
  const qp: Record<string, unknown> = {};
  const conditions: string[] = [];

  if (repo) {
    conditions.push('es.repo = $repo');
    qp['repo'] = repo;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const cypher = `
    MATCH (es:ExternalService)
    ${whereClause}
    RETURN es.name AS name, es.repo AS repo, es.kind AS kind,
           es.protocol AS protocol, es.host AS host
    ORDER BY es.repo, es.name
  `;

  const rows = await ctx.graph.runRead(cypher, qp, (r) => ({
    name: r.get('name'),
    repo: r.get('repo'),
    kind: r.get('kind'),
    protocol: r.get('protocol'),
    host: r.get('host'),
  }));

  return structuredResponse(rows, `Found ${rows.length} external service(s).`);
}
