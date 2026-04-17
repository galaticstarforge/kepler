/**
 * Frontmatter schema types for structured markdown documents.
 *
 * Every document should declare YAML frontmatter. Validation failures
 * are logged but do not block writes — drafting with incomplete
 * frontmatter is a supported workflow.
 */

export type DocumentType =
  | 'adr'
  | 'runbook'
  | 'guide'
  | 'overview'
  | 'reference'
  | 'changelog'
  | 'incident'
  | 'postmortem'
  | 'api'
  | 'schema'
  | 'pattern'
  | 'glossary'
  | 'service-map';

export type DocumentStatus = 'current' | 'draft' | 'deprecated' | 'proposed';

export interface SymbolReference {
  repo: string;
  path: string;
  name: string;
}

export interface RelatedEntry {
  path: string;
}

export interface Frontmatter {
  title: string;
  type: DocumentType;
  status: DocumentStatus;
  author: string;
  created: string; // ISO 8601
  updated: string; // ISO 8601
  domain?: string;
  service?: string;
  app?: string;
  tags?: string[];
  related?: RelatedEntry[];
  symbols?: SymbolReference[];
  supersedes?: string;
  confluence_sync?: boolean;
}

/** Result of parsing frontmatter — always returned, never thrown. */
export interface FrontmatterParseResult {
  valid: boolean;
  data: Partial<Frontmatter>;
  errors: string[];
  /** Markdown body after frontmatter has been stripped. */
  body: string;
}
