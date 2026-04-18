import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function adminPluginStatus(
  _params: Record<string, unknown>,
  _ctx: HandlerContext,
): Promise<McpToolResponse> {
  return structuredResponse(
    { plugins: [], note: 'Plugin loader lands in Phase J.' },
    'No plugins loaded. Plugin support is not yet enabled.',
  );
}
