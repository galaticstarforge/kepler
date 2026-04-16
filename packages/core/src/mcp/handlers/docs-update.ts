import { parseFrontmatter } from '../../docs/frontmatter-parser.js';
import { stripMarkdown } from '../../docs/markdown-stripper.js';
import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, textResponse } from '../types.js';

export async function docsUpdate(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const docPath = params['path'] as string | undefined;
  const content = params['content'] as string | undefined;

  if (!docPath) return errorResponse('Missing required parameter: path');
  if (!content) return errorResponse('Missing required parameter: content');

  const existing = await ctx.store.head(docPath);
  if (!existing) return errorResponse(`Document not found: "${docPath}". Use docs.create instead.`);

  const buf = Buffer.from(content, 'utf8');
  const parsed = parseFrontmatter(content);

  if (!parsed.valid) {
    ctx.logger.warn('frontmatter validation warnings on update', {
      path: docPath,
      errors: parsed.errors,
    });
  }

  const custom: Record<string, string> = {};
  if (parsed.data.type) custom['type'] = parsed.data.type;
  if (parsed.data.status) custom['status'] = parsed.data.status;
  if (parsed.data.author) custom['author'] = parsed.data.author;

  await ctx.store.put(docPath, buf, {
    contentType: 'text/markdown',
    contentLength: buf.length,
    lastModified: new Date(),
    custom,
  });

  // Re-index for semantic search.
  const plainText = stripMarkdown(parsed.body);
  if (plainText.trim()) {
    const metadata: Record<string, string> = { ...custom };
    if (parsed.data.title) metadata['title'] = parsed.data.title;
    await ctx.index.upsert({ path: docPath, content: plainText, metadata });
  }

  return textResponse(`Updated document at "${docPath}".`);
}
