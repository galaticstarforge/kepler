import { describe, it, expect } from 'vitest';

import { stripMarkdown } from '../src/docs/markdown-stripper.js';

describe('stripMarkdown', () => {
  it('strips headers', () => {
    const result = stripMarkdown('# Title\n\n## Subtitle\n\nParagraph.');
    expect(result).not.toContain('#');
    expect(result).toContain('Title');
    expect(result).toContain('Paragraph.');
  });

  it('strips bold and italic', () => {
    const result = stripMarkdown('This is **bold** and *italic* text.');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
    expect(result).not.toContain('**');
    expect(result).not.toContain('*');
  });

  it('strips links', () => {
    const result = stripMarkdown('Visit [Google](https://google.com) for search.');
    expect(result).toContain('Google');
    expect(result).not.toContain('[');
    expect(result).not.toContain('](');
  });

  it('strips fenced code blocks', () => {
    const result = stripMarkdown('Before\n\n```typescript\nconst x = 1;\n```\n\nAfter');
    expect(result).not.toContain('const x');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('strips HTML comments', () => {
    const result = stripMarkdown('Before <!-- comment --> After');
    expect(result).not.toContain('comment');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('strips enrichment delimiter blocks', () => {
    const md = `Some content.

<!-- enrichment:related-code:begin -->
## Related Code
- \`handlePayment()\`: link
<!-- enrichment:related-code:end -->

More content.`;
    const result = stripMarkdown(md);
    expect(result).not.toContain('enrichment');
    expect(result).toContain('Some content.');
    expect(result).toContain('More content.');
  });

  it('collapses excessive whitespace', () => {
    const result = stripMarkdown('A\n\n\n\n\nB');
    expect(result).toBe('A\n\nB');
  });

  it('handles empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });
});
