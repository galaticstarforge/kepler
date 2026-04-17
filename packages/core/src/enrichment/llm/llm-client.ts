/**
 * LLM client interface used by the enrichment pipeline.
 *
 * Kept internal to @kepler/core — not re-exported from @kepler/shared to
 * avoid pulling provider SDK types into the public surface.
 */

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Hard cap on output tokens. */
  maxTokens?: number;
  /** Nudge the provider to return JSON when supported. */
  jsonMode?: boolean;
}

export interface CompletionResponse {
  text: string;
}

export interface EmbeddingRequest {
  text: string;
}

export interface EmbeddingResponse {
  /** Raw float vector. Dimensionality depends on the configured model. */
  vector: Float32Array;
  model: string;
}

export interface LlmClient {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
