import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function graphServiceTopology(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = params['repo'] as string | undefined;
  const qp: Record<string, unknown> = {};
  const conditions: string[] = [];

  if (repo) {
    conditions.push('m.repo = $repo');
    qp['repo'] = repo;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Topology: which modules/symbols call which external services.
  const cypher = `
    MATCH (m:Module)-[:CALLS_SERVICE]->(es:ExternalService)
    ${whereClause}
    RETURN m.repo AS callerRepo, m.path AS callerModule,
           es.name AS service, es.kind AS serviceKind,
           es.protocol AS protocol
    ORDER BY m.repo, es.name
  `;

  const rows = await ctx.graph.runRead(cypher, qp, (r) => ({
    callerRepo: r.get('callerRepo'),
    callerModule: r.get('callerModule'),
    service: r.get('service'),
    serviceKind: r.get('serviceKind'),
    protocol: r.get('protocol'),
  }));

  // Group into service → callers map for easier consumption.
  const topology: Record<string, { service: string; kind: string; callers: string[] }> = {};
  for (const row of rows) {
    const key = row.service as string;
    if (!topology[key]) {
      topology[key] = { service: key, kind: row.serviceKind as string, callers: [] };
    }
    topology[key]!.callers.push(`${row.callerRepo}/${row.callerModule}`);
  }

  const services = Object.values(topology);
  return structuredResponse(
    { services },
    `Service topology: ${services.length} external service(s) across ${rows.length} call edge(s).`,
  );
}
