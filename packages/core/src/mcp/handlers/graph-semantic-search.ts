import { VECTOR_INDEX_NAMES } from '../../graph/schema.js';
import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

import { SERVICE_UNAVAILABLE } from './service-status.js';

const MAX_TOP_K = 20;
const DEFAULT_TOP_K = 5;

type SearchKind = 'Symbol' | 'Community';

/**
 * `graph.semanticSearch` — vector similarity search over `SymbolSummary`
 * / `CommunitySummary` embeddings.
 *
 * Phase D behavior: if either vector index is not `ONLINE`, the handler
 * refuses with a service-unavailable marker that the router translates
 * into an HTTP 503 at the transport layer. The full semantic search
 * ranking / fusion logic lands in Phase E.
 */
export async function graphSemanticSearch(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const probe = ctx.vectorIndexReadiness;
  if (probe) {
    const snapshot = await probe.snapshot();
    if (!snapshot.ready) {
      return SERVICE_UNAVAILABLE(
        'Vector indexes are not ONLINE yet. See /ready for status.',
        { indexes: snapshot.indexes },
      );
    }
  }

  const queryVector = params['queryVector'];
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return structuredResponse(
      {
        hits: [],
        note: "graph.semanticSearch requires 'queryVector' until the embedding provider lands in Phase F.",
      },
      'No embedding provider configured; returning empty result set.',
    );
  }

  const kindRaw = params['kind'];
  const kind: SearchKind = kindRaw === 'Community' ? 'Community' : 'Symbol';
  const topKRaw = params['topK'];
  const topK = clampTopK(typeof topKRaw === 'number' ? topKRaw : DEFAULT_TOP_K);

  const indexName =
    kind === 'Symbol' ? VECTOR_INDEX_NAMES.symbolSummary : VECTOR_INDEX_NAMES.communitySummary;
  const label = kind === 'Symbol' ? 'SymbolSummary' : 'CommunitySummary';

  const rows = await ctx.graph.runRead(
    `CALL db.index.vector.queryNodes($indexName, $topK, $vector)
     YIELD node, score
     WITH node, score
     WHERE node:${label}
     RETURN node AS summary, score`,
    { indexName, topK, vector: queryVector as number[] },
    (r) => ({
      score: Number(r.get('score')),
      summary: (r.get('summary') as { properties?: Record<string, unknown> }).properties ?? {},
    }),
  );

  return structuredResponse(
    { hits: rows, kind, topK },
    `graph.semanticSearch returned ${rows.length} ${kind}Summary hit(s).`,
  );
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOP_K;
  if (value > MAX_TOP_K) return MAX_TOP_K;
  return Math.floor(value);
}
