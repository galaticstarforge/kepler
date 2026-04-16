import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, textResponse } from '../types.js';

export async function docsApplyTemplate(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const templateName = params['template'] as string | undefined;
  const outputPath = params['path'] as string | undefined;
  const vars = (params['variables'] as Record<string, string> | undefined) ?? {};

  if (!templateName) return errorResponse('Missing required parameter: template');
  if (!outputPath) return errorResponse('Missing required parameter: path');

  const existing = await ctx.store.head(outputPath);
  if (existing) return errorResponse(`Document already exists at "${outputPath}".`);

  const rendered = await ctx.templates.applyTemplate(templateName, vars);
  if (rendered === null) return errorResponse(`Template "${templateName}" not found.`);

  const buf = Buffer.from(rendered, 'utf8');
  await ctx.store.put(outputPath, buf, {
    contentType: 'text/markdown',
    contentLength: buf.length,
    lastModified: new Date(),
    custom: {},
  });

  return textResponse(`Created document at "${outputPath}" from template "${templateName}".`);
}
