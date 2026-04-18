export { BedrockSemanticIndex } from './bedrock-semantic-index.js';
export type { BedrockSemanticIndexConfig } from './bedrock-semantic-index.js';
export { NoopSemanticIndex } from './noop-semantic-index.js';
export { createSemanticIndex } from './semantic-index-factory.js';
export {
  EmbeddingModelRatchet,
  EMBEDDING_MODEL_META_PATH,
} from './embedding-model-ratchet.js';
export type {
  EmbeddingModelRatchetDeps,
  EmbeddingModelRatchetResult,
  EmbeddingModelRecord,
} from './embedding-model-ratchet.js';
export { VectorIndexReadiness } from './vector-index-readiness.js';
export type {
  VectorIndexReadinessDeps,
  VectorIndexReadinessSnapshot,
  VectorIndexState,
} from './vector-index-readiness.js';
