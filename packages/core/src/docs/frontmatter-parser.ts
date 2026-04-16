
import { DOCUMENT_TYPES, DOCUMENT_STATUSES } from '@kepler/shared';
import type { Frontmatter, FrontmatterParseResult } from '@kepler/shared';
import matter from 'gray-matter';

const REQUIRED_FIELDS: (keyof Frontmatter)[] = [
  'title',
  'type',
  'status',
  'author',
  'created',
  'updated',
];

/**
 * Parse YAML frontmatter from markdown content. Never throws — returns
 * a result with `valid: false` and collected error messages when
 * validation fails.
 */
export function parseFrontmatter(content: Buffer | string): FrontmatterParseResult {
  const raw = typeof content === 'string' ? content : content.toString('utf8');
  const errors: string[] = [];

  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return { valid: false, data: {}, errors: ['Failed to parse YAML frontmatter'], body: raw };
  }

  // If there's no frontmatter at all, return early.
  if (Object.keys(data).length === 0) {
    return { valid: false, data: {}, errors: ['No frontmatter found'], body };
  }

  // Validate required fields.
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate type enum.
  if (data['type'] && !DOCUMENT_TYPES.includes(data['type'] as typeof DOCUMENT_TYPES[number])) {
    errors.push(`Invalid document type: "${data['type'] as string}". Expected one of: ${DOCUMENT_TYPES.join(', ')}`);
  }

  // Validate status enum.
  if (data['status'] && !DOCUMENT_STATUSES.includes(data['status'] as typeof DOCUMENT_STATUSES[number])) {
    errors.push(`Invalid document status: "${data['status'] as string}". Expected one of: ${DOCUMENT_STATUSES.join(', ')}`);
  }

  // Coerce date fields to strings.
  for (const field of ['created', 'updated'] as const) {
    if (data[field] instanceof Date) {
      data[field] = (data[field] as Date).toISOString().split('T')[0]!;
    }
  }

  return {
    valid: errors.length === 0,
    data: data as Partial<Frontmatter>,
    errors,
    body,
  };
}
