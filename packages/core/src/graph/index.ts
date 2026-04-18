export { GraphClient } from './graph-client.js';
export type { GraphClientOptions, AccessMode } from './graph-client.js';
export { createGraphClient } from './graph-client-factory.js';
export {
  CORE_INDEX_STATEMENTS,
  VECTOR_INDEX_NAMES,
  MIN_NEO4J_VERSION_FOR_VECTOR,
  vectorIndexStatements,
  vectorIndexDropStatements,
  compareSemver,
  meetsVectorIndexMinimum,
} from './schema.js';
export type { VectorIndexName } from './schema.js';
