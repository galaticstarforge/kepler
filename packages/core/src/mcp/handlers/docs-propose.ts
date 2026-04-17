import { PROPOSALS_PREFIX } from '@kepler/shared';

import { parseFrontmatter } from '../../docs/frontmatter-parser.js';
import { stripMarkdown } from '../../docs/markdown-stripper.js';
import type { HandlerContext, McpToolResponse } from '../types.js';
import { errorResponse, textResponse } from '../types.js';

export async function docsPropose(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<McpToolResponse> {
  const name = params['name'] as string | undefined;
  const content = params['content'] as string | undefined;

  if (!name) return errorResponse('Missing required parameter: name');
  if (!content) return errorResponse('Missing required parameter: content');

  const docPath = PROPOSALS_PREFIX + (name.endsWith('.md') ? name : name + '.md');

  const buf = Buffer.from(content, 'utf8');
  const parsed = parseFrontmatter(content);

  const custom: Record<string, string> = {
    author: parsed.data.author ?? 'claude-code',
    status: 'proposed',
  };
  if (parsed.data.type) custom['type'] = parsed.data.type;

  await ctx.store.put(docPath, buf, {
    contentType: 'text/markdown',
    contentLength: buf.length,
    lastModified: new Date(),
    custom,
  });

  // Index proposals into semantic search (filtered by default).
  const plainText = stripMarkdown(parsed.body);
  if (plainText.trim()) {
    const metadata: Record<string, string> = { ...custom };
    if (parsed.data.title) metadata['title'] = parsed.data.title;
    await ctx.index.upsert({ path: docPath, content: plainText, metadata });
  }

  return textResponse(`Proposed document created at "${docPath}".`);
}
