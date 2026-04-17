import { parseFrontmatter } from '../../docs/frontmatter-parser.js';
import { stripMarkdown } from '../../docs/markdown-stripper.js';
import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, textResponse } from '../types.js';

export async function docsCreate(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const docPath = params['path'] as string | undefined;
  const content = params['content'] as string | undefined;

  if (!docPath) return errorResponse('Missing required parameter: path');
  if (!content) return errorResponse('Missing required parameter: content');

  const existing = await ctx.store.head(docPath);
  if (existing) return errorResponse(`Document already exists at "${docPath}". Use docs.update instead.`);

  const buf = Buffer.from(content, 'utf8');
  const parsed = parseFrontmatter(content);

  if (!parsed.valid) {
    ctx.logger.warn('frontmatter validation warnings on create', {
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

  // Index for semantic search.
  const plainText = stripMarkdown(parsed.body);
  if (plainText.trim()) {
    const metadata: Record<string, string> = { ...custom };
    if (parsed.data.title) metadata['title'] = parsed.data.title;
    await ctx.index.upsert({ path: docPath, content: plainText, metadata });
  }

  await ctx.graph.runWrite(
    `MERGE (d:Document {path: $path})
     SET d.title    = $title,
         d.type     = $type,
         d.status   = $status,
         d.author   = $author,
         d.domain   = $domain,
         d.service  = $service,
         d.updatedAt = $updatedAt`,
    {
      path:      docPath,
      title:     parsed.data.title   ?? null,
      type:      parsed.data.type    ?? null,
      status:    parsed.data.status  ?? null,
      author:    parsed.data.author  ?? null,
      domain:    parsed.data.domain  ?? null,
      service:   parsed.data.service ?? null,
      updatedAt: new Date().toISOString(),
    },
  );

  return textResponse(`Created document at "${docPath}".`);
}
