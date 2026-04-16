import { describe, it, expect } from 'vitest';

import { parseFrontmatter } from '../src/docs/frontmatter-parser.js';

const VALID_DOC = `---
title: Test Document
type: adr
status: proposed
author: human
created: 2026-01-01
updated: 2026-01-02
---

# Test

Body content here.
`;

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const result = parseFrontmatter(VALID_DOC);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data.title).toBe('Test Document');
    expect(result.data.type).toBe('adr');
    expect(result.data.status).toBe('proposed');
    expect(result.data.author).toBe('human');
    expect(result.body).toContain('# Test');
    expect(result.body).toContain('Body content here.');
  });

  it('accepts a Buffer input', () => {
    const result = parseFrontmatter(Buffer.from(VALID_DOC));
    expect(result.valid).toBe(true);
    expect(result.data.title).toBe('Test Document');
  });

  it('reports missing required fields', () => {
    const doc = `---
title: Incomplete
---

Some body.
`;
    const result = parseFrontmatter(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('type'))).toBe(true);
    expect(result.errors.some((e) => e.includes('status'))).toBe(true);
    expect(result.data.title).toBe('Incomplete');
  });

  it('reports invalid document type', () => {
    const doc = `---
title: Bad Type
type: invalid-type
status: draft
author: test
created: 2026-01-01
updated: 2026-01-01
---

Body.
`;
    const result = parseFrontmatter(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid document type'))).toBe(true);
  });

  it('reports invalid document status', () => {
    const doc = `---
title: Bad Status
type: guide
status: invalid-status
author: test
created: 2026-01-01
updated: 2026-01-01
---

Body.
`;
    const result = parseFrontmatter(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid document status'))).toBe(true);
  });

  it('handles document with no frontmatter', () => {
    const doc = '# Just Markdown\n\nNo frontmatter here.';
    const result = parseFrontmatter(doc);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No frontmatter found');
    expect(result.body).toContain('# Just Markdown');
  });

  it('coerces Date objects to ISO strings', () => {
    const doc = `---
title: Date Test
type: guide
status: draft
author: test
created: 2026-01-15
updated: 2026-01-16
---

Body.
`;
    const result = parseFrontmatter(doc);
    // gray-matter parses YYYY-MM-DD as Date objects
    expect(typeof result.data.created).toBe('string');
    expect(typeof result.data.updated).toBe('string');
  });

  it('preserves optional fields when present', () => {
    const doc = `---
title: Full Doc
type: overview
status: current
author: human
created: 2026-01-01
updated: 2026-01-01
domain: payments
service: auth-service
tags:
  - important
  - auth
symbols:
  - repo: my-repo
    path: src/auth.ts
    name: authenticate
---

Body.
`;
    const result = parseFrontmatter(doc);
    expect(result.valid).toBe(true);
    expect(result.data.domain).toBe('payments');
    expect(result.data.service).toBe('auth-service');
    expect(result.data.tags).toEqual(['important', 'auth']);
    expect(result.data.symbols).toHaveLength(1);
    expect(result.data.symbols![0]!.name).toBe('authenticate');
  });

  it('returns partial data even when invalid', () => {
    const doc = `---
title: Partial
type: bad-type
---

Body.
`;
    const result = parseFrontmatter(doc);
    expect(result.valid).toBe(false);
    expect(result.data.title).toBe('Partial');
  });
});
