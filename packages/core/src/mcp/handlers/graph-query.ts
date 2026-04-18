import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

const MUTATION_PATTERN =
  /\b(CREATE|MERGE|SET|DELETE|DETACH\s+DELETE|REMOVE|DROP|CALL\s+db\.)\b/i;

const QUERY_TIMEOUT_MS = 10_000;
const MAX_ROWS = 1_000;

export async function graphQuery(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const cypher = params['cypher'] as string | undefined;
  const queryParams = (params['params'] as Record<string, unknown>) ?? {};

  if (!cypher) return errorResponse('Missing required parameter: cypher');

  if (MUTATION_PATTERN.test(cypher)) {
    return errorResponse(
      'graph.query is read-only. Mutation keywords (CREATE, MERGE, SET, DELETE, REMOVE, DROP, CALL db.*) are not permitted.',
    );
  }

  const readPromise = ctx.graph.runRead(cypher, queryParams, (r) => r.toObject());
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Query exceeded 10 s timeout.')), QUERY_TIMEOUT_MS),
  );

  let records: Record<string, unknown>[];
  try {
    records = await Promise.race([readPromise, timeoutPromise]);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(msg);
  }

  if (records.length > MAX_ROWS) {
    records = records.slice(0, MAX_ROWS);
    return structuredResponse(
      records,
      `Query returned more than ${MAX_ROWS} rows; results truncated to ${MAX_ROWS}.`,
    );
  }

  return structuredResponse(records, `Query returned ${records.length} record(s).`);
}
