export const DEFAULT_REGION = 'us-east-1';
export const STATE_BUCKET_PREFIX = 'kepler-state-';
export const DOCS_BUCKET_PREFIX = 'kepler-docs-';
export const STACK_PREFIX = 'kepler-';
export const TAG_DEPLOYMENT = 'kepler:deployment';
export const TAG_MANAGED = 'kepler:managed';
export const TAG_VERSION = 'kepler:version';
export const DEFAULT_PORT = 8080;
export const LOG_GROUP_PREFIX = '/kepler/';
export const KEPLER_VERSION = '0.0.1';

// Document store path prefixes
export const META_PREFIX = '_meta/';
export const TEMPLATES_PREFIX = '_meta/templates/';
export const CLAUDE_PREFIX = '.claude/';
export const PROPOSALS_PREFIX = '.claude/proposals/';
export const SCRATCHPAD_PREFIX = '.claude/scratchpad/';
export const SESSIONS_PREFIX = '.claude/sessions/';

// Document types and statuses (must match the type unions in frontmatter.ts)
export const DOCUMENT_TYPES = [
  'adr',
  'runbook',
  'guide',
  'overview',
  'reference',
  'changelog',
  'incident',
  'postmortem',
  'api',
  'schema',
  'pattern',
  'glossary',
  'service-map',
] as const;

export const DOCUMENT_STATUSES = [
  'current',
  'draft',
  'deprecated',
  'proposed',
] as const;
