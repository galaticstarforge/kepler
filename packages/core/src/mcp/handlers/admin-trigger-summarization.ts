import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, structuredResponse } from '../types.js';

const VALID_MODES = ['full', 'incremental', 'priority-only'] as const;
type Mode = (typeof VALID_MODES)[number];

export async function adminTriggerSummarization(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  if (!ctx.summarizationAgent) {
    return errorResponse(
      'Summarization agent is not configured. Ensure sourceAccess.enabled=true and a valid LLM provider is configured.',
    );
  }

  const rawMode = params['mode'] as string | undefined;
  const mode: Mode = VALID_MODES.includes(rawMode as Mode) ? (rawMode as Mode) : 'incremental';
  const repo = typeof params['repo'] === 'string' ? params['repo'] : '';

  if (!repo) {
    return errorResponse('`repo` parameter is required.');
  }

  const runId = ctx.summarizationAgent.trigger({
    repo,
    mode,
    embeddingModel: ctx.summarizationEmbeddingModel ?? 'amazon.titan-embed-text-v2:0',
    maxRunCostUSD: ctx.maxRunCostUSD ?? 0,
  });

  ctx.logger.info('admin.triggerSummarization', {
    traceId: ctx.traceId,
    runId,
    mode,
    repo,
  });

  return structuredResponse(
    { runId, mode, repo, status: 'started' },
    `Summarization run started. runId: ${runId}`,
  );
}
