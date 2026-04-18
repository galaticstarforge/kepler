import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function adminDiagnostics(
  _params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const checks: Record<string, unknown> = {};

  // Neo4j connectivity.
  let neo4jOk = false;
  try {
    await ctx.graph.ping();
    neo4jOk = true;
  } catch (error) {
    checks['neo4jError'] = error instanceof Error ? error.message : String(error);
  }
  checks['neo4j'] = neo4jOk ? 'ok' : 'error';

  // Graph counts.
  if (neo4jOk) {
    try {
      const countRows = await ctx.graph.runRead(
        `MATCH (s:Symbol) RETURN count(s) AS symbolCount
         UNION ALL MATCH (m:Module) RETURN count(m) AS symbolCount
         UNION ALL MATCH (d:Document) RETURN count(d) AS symbolCount`,
        {},
        (r) => Number(r.get('symbolCount')),
      );
      const [symbolCount, moduleCount, documentCount] = countRows;
      checks['symbolCount'] = symbolCount ?? 0;
      checks['moduleCount'] = moduleCount ?? 0;
      checks['documentCount'] = documentCount ?? 0;
    } catch {
      checks['countError'] = 'failed to fetch counts';
    }

    try {
      const indexRows = await ctx.graph.runRead(
        `SHOW INDEXES YIELD name, state, type WHERE state = 'ONLINE' RETURN count(*) AS n`,
        {},
        (r) => Number(r.get('n')),
      );
      checks['onlineIndexes'] = indexRows[0] ?? 0;
    } catch {
      checks['indexError'] = 'failed to fetch index states';
    }
  }

  // Vector index readiness.
  if (ctx.vectorIndexReadiness) {
    try {
      const snapshot = await ctx.vectorIndexReadiness.snapshot();
      checks['vectorIndexes'] = snapshot.indexes;
      checks['vectorIndexesReady'] = snapshot.ready;
    } catch {
      checks['vectorIndexError'] = 'failed to check vector index readiness';
    }
  }

  // Orchestrator status.
  if (ctx.orchestrator) {
    checks['inFlightRepos'] = ctx.orchestrator.inFlightRepos();
    checks['configuredRepos'] = ctx.orchestrator.configuredRepos();
  }

  const allOk = neo4jOk;
  return structuredResponse(
    { status: allOk ? 'ok' : 'degraded', checks },
    `System diagnostics: ${allOk ? 'all checks passed' : 'some checks failed'}.`,
  );
}
