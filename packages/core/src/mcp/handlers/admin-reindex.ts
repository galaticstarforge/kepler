import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse, textResponse } from '../types.js';

export async function adminReindex(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const repo = params['repo'] as string | undefined;

  if (!ctx.orchestrator) {
    return textResponse(
      'Orchestrator is not running. Source access must be enabled to trigger reindexing.',
    );
  }

  const inFlight = ctx.orchestrator.inFlightRepos();
  const configured = ctx.orchestrator.configuredRepos();

  const targetRepos = repo ? [repo] : configured;
  const alreadyInFlight = targetRepos.filter((r) => inFlight.includes(r));

  return structuredResponse(
    {
      requestedRepos: targetRepos,
      inFlightRepos: inFlight,
      alreadyIndexing: alreadyInFlight,
      note: 'Reindex will be triggered on the next git polling cycle for repos not currently in flight.',
    },
    alreadyInFlight.length > 0
      ? `${alreadyInFlight.length} repo(s) already indexing. Remaining repos scheduled for next poll.`
      : `Reindex scheduled for ${targetRepos.length} repo(s).`,
  );
}
