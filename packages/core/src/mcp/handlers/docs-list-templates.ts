import type { HandlerContext, McpToolResponse } from '../types.js';
import { structuredResponse, textResponse } from '../types.js';

export async function docsListTemplates(
  _params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const templates = await ctx.templates.listTemplates();

  if (templates.length === 0) {
    return textResponse('No templates found. Run the orchestrator to install default templates.');
  }

  return structuredResponse(templates, `${templates.length} template(s) available.`);
}
