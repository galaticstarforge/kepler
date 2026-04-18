import { EnrichmentError } from '@keplerforge/shared';

import type { CompletionResponse, EmbeddingResponse, LlmClient } from './llm-client.js';

/**
 * LLM client that refuses all calls. Used when concept extraction is
 * disabled so that accidental invocations fail loudly rather than hitting
 * AWS silently.
 */
export class NoopLlmClient implements LlmClient {
  complete(): Promise<CompletionResponse> {
    return Promise.reject(
      new EnrichmentError('LLM client is disabled; enable enrichment.conceptExtraction to use it.'),
    );
  }

  embed(): Promise<EmbeddingResponse> {
    return Promise.reject(
      new EnrichmentError('LLM client is disabled; enable enrichment.conceptExtraction to use it.'),
    );
  }
}
