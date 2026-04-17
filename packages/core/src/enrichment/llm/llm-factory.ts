import type { ConceptExtractionConfig } from '../../config.js';

import { BedrockLlmClient } from './bedrock-llm-client.js';
import type { LlmClient } from './llm-client.js';
import { NoopLlmClient } from './noop-llm-client.js';

export function createLlmClient(
  config: ConceptExtractionConfig,
  fallbackRegion: string,
): LlmClient {
  if (!config.enabled || config.provider === 'none') {
    return new NoopLlmClient();
  }

  if (config.provider === 'bedrock') {
    return new BedrockLlmClient({
      region: config.region ?? fallbackRegion,
      completionModel: config.model,
      embeddingModel: config.embeddingModel,
    });
  }

  const exhaustive: never = config.provider;
  throw new Error(`Unsupported LLM provider: ${String(exhaustive)}`);
}
