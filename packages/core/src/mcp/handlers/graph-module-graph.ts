import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

export async function graphModuleGraph(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = params['repo'] as string | undefined;
  const pathPrefix = params['pathPrefix'] as string | undefined;
  const limit = Math.min(typeof params['limit'] === 'number' ? params['limit'] : 50, 200);

  if (!repo) return errorResponse('Missing required parameter: repo');

  const conditions = ['m.repo = $repo'];
  const qp: Record<string, unknown> = { repo, limit };

  if (pathPrefix) {
    conditions.push('m.path STARTS WITH $pathPrefix');
    qp['pathPrefix'] = pathPrefix;
  }

  const cypher = `
    MATCH (m:Module)
    WHERE ${conditions.join(' AND ')}
    OPTIONAL MATCH (m)-[rel:IMPORTS]->(dep:Module)
    WITH m, collect({
      to: dep.path, toRepo: dep.repo, kind: type(rel)
    }) AS edges
    RETURN m.path AS path, m.repo AS repo, edges
    ORDER BY m.path
    LIMIT $limit
  `;

  const rows = await ctx.graph.runRead(cypher, qp, (r) => ({
    path: r.get('path'),
    repo: r.get('repo'),
    edges: r.get('edges'),
  }));

  const nodes = rows.map((r) => ({ path: r.path, repo: r.repo }));
  const edges = rows.flatMap((r) =>
    (r.edges as Array<{ to: string; toRepo: string; kind: string }>)
      .filter((e) => e.to != null)
      .map((e) => ({ from: r.path, to: e.to, toRepo: e.toRepo })),
  );

  return structuredResponse(
    { nodes, edges },
    `Module graph for repo "${repo}": ${nodes.length} module(s), ${edges.length} import edge(s).`,
  );
}
