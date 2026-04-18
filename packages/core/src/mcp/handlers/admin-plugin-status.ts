import type { McpToolResponse } from '../types.js';
import { structuredResponse } from '../types.js';

export async function adminPluginStatus(): Promise<McpToolResponse> {
  return structuredResponse(
    { plugins: [], note: 'Plugin loader lands in Phase J.' },
    'No plugins loaded. Plugin support is not yet enabled.',
  );
}
