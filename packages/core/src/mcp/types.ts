import type { DocumentStore, SemanticIndex } from '@kepler/shared';

import type { TemplateManager } from '../docs/template-manager.js';
import type { ConceptStore } from '../enrichment/concept-store.js';
import type { EnrichmentRunner } from '../enrichment/enrichment-runner.js';
import type { GraphClient } from '../graph/graph-client.js';
import type { Logger } from '../logger.js';

export interface HandlerContext {
  store: DocumentStore;
  index: SemanticIndex;
  graph: GraphClient;
  templates: TemplateManager;
  conceptStore: ConceptStore;
  enrichmentRunner: EnrichmentRunner;
  logger: Logger;
}

export interface McpContentBlock {
  type: 'text' | 'resource' | 'structured';
  text?: string;
  data?: unknown;
}

export interface McpToolResponse {
  content: McpContentBlock[];
  isError?: boolean;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<McpToolResponse>;

export function textResponse(text: string): McpToolResponse {
  return { content: [{ type: 'text', text }] };
}

export function errorResponse(message: string): McpToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function structuredResponse(data: unknown, summary?: string): McpToolResponse {
  const content: McpContentBlock[] = [];
  if (summary) content.push({ type: 'text', text: summary });
  content.push({ type: 'structured', data });
  return { content };
}
