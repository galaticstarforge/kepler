import type { DocumentStore, SemanticIndex } from '@kepler/shared';

import type { TemplateManager } from '../docs/template-manager.js';
import type { ConceptStore } from '../enrichment/concept-store.js';
import type { EnrichmentRunner } from '../enrichment/enrichment-runner.js';
import type { GraphClient } from '../graph/graph-client.js';
import type { PassRunHistoryStore } from '../indexer/pass-run-history-store.js';
import type { Logger } from '../logger.js';
import type { VectorIndexReadiness } from '../semantic/vector-index-readiness.js';
import type { SummarizationAgent } from '../summarization/agent.js';

export interface OrchestratorHandle {
  inFlightRepos(): string[];
  configuredRepos(): string[];
}

export interface HandlerContext {
  store: DocumentStore;
  index: SemanticIndex;
  graph: GraphClient;
  templates: TemplateManager;
  conceptStore: ConceptStore;
  enrichmentRunner: EnrichmentRunner;
  logger: Logger;
  vectorIndexReadiness?: VectorIndexReadiness;
  passRunHistory?: PassRunHistoryStore;
  orchestrator?: OrchestratorHandle | null;
  summarizationAgent?: SummarizationAgent | null;
  /** Embedding model identifier forwarded to the agent for SymbolSummary nodes. */
  summarizationEmbeddingModel?: string;
  /** Per-run cost ceiling forwarded to the agent. */
  maxRunCostUSD?: number;
  /** Populated per-request by McpRouter before calling handlers. */
  traceId: string;
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
