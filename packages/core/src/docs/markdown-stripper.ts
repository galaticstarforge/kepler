import removeMd from 'remove-markdown';

/**
 * Strip markdown to plain text suitable for semantic indexing.
 *
 * Removes frontmatter (caller should strip it first or pass the body),
 * markdown syntax, HTML tags, and HTML comments (including enrichment
 * delimiters).
 */
export function stripMarkdown(markdown: string): string {
  // Remove HTML comments (including multiline enrichment blocks).
  let text = markdown.replaceAll(/<!--[\s\S]*?-->/g, '');

  // Remove fenced code blocks (``` or ~~~).
  text = text.replaceAll(/^(`{3,}|~{3,})[\s\S]*?^\1/gm, '');

  // Use remove-markdown for the rest.
  text = removeMd(text, { stripListLeaders: true, gfm: true, useImgAltText: true });

  // Collapse whitespace.
  text = text.replaceAll(/\n{3,}/g, '\n\n').trim();

  return text;
}
