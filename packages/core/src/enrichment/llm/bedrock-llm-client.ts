import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EnrichmentError } from '@keplerforge/shared';

import { getBedrockRuntimeClient } from '../../aws-clients.js';
import { createLogger } from '../../logger.js';

import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmClient,
} from './llm-client.js';

const log = createLogger('bedrock-llm-client');

export interface BedrockLlmClientConfig {
  region: string;
  completionModel: string;
  embeddingModel: string;
}

/**
 * LLM client backed by Bedrock InvokeModel.
 *
 * NOTE: The embeddings produced here live in a DIFFERENT vector space than
 * whatever the Bedrock Knowledge Base uses internally for document search.
 * Use these embeddings only for concept↔concept deduplication — never feed
 * them to SemanticIndex.search.
 */
export class BedrockLlmClient implements LlmClient {
  private readonly client;
  private readonly config: BedrockLlmClientConfig;

  constructor(config: BedrockLlmClientConfig) {
    this.config = config;
    this.client = getBedrockRuntimeClient(config.region);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.maxTokens ?? 2048,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
    };

    try {
      const resp = await this.client.send(
        new InvokeModelCommand({
          modelId: this.config.completionModel,
          contentType: 'application/json',
          accept: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(body)),
        }),
      );

      const payload = JSON.parse(new TextDecoder().decode(resp.body)) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text =
        payload.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('') ?? '';
      return { text };
    } catch (error: unknown) {
      log.warn('completion failed', { error: String(error) });
      throw new EnrichmentError('Bedrock completion failed', error);
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const body = { inputText: req.text };

    try {
      const resp = await this.client.send(
        new InvokeModelCommand({
          modelId: this.config.embeddingModel,
          contentType: 'application/json',
          accept: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(body)),
        }),
      );

      const payload = JSON.parse(new TextDecoder().decode(resp.body)) as { embedding?: number[] };
      if (!payload.embedding) {
        throw new EnrichmentError('Bedrock embedding response missing `embedding` field');
      }
      return {
        vector: Float32Array.from(payload.embedding),
        model: this.config.embeddingModel,
      };
    } catch (error: unknown) {
      if (error instanceof EnrichmentError) throw error;
      log.warn('embedding failed', { error: String(error) });
      throw new EnrichmentError('Bedrock embedding failed', error);
    }
  }
}
