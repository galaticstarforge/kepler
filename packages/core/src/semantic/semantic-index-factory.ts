import type { SemanticIndex } from '@kepler/shared';

import type { SemanticIndexConfig } from '../config.js';

import { BedrockSemanticIndex } from './bedrock-semantic-index.js';
import { NoopSemanticIndex } from './noop-semantic-index.js';

export function createSemanticIndex(config: SemanticIndexConfig): SemanticIndex {
  switch (config.provider) {
    case 'bedrock': {
      if (!config.knowledgeBaseId) {
        throw new Error('storage.semanticIndex.knowledgeBaseId is required for Bedrock provider');
      }
      return new BedrockSemanticIndex({
        knowledgeBaseId: config.knowledgeBaseId,
        region: config.region ?? 'us-east-1',
        dataSourceId: config.dataSourceId,
      });
    }
    case 'none': {
      return new NoopSemanticIndex();
    }
    default: {
      // pgvector and sqlite are planned but not yet implemented.
      throw new Error(`Unsupported semantic index provider: ${config.provider}`);
    }
  }
}
