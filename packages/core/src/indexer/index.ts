export { Orchestrator } from './orchestrator.js';
export type { OrchestratorDeps } from './orchestrator.js';
export { FileDiscovery } from './file-discovery.js';
export type { DiscoveredFile, FileDiscoveryDeps } from './file-discovery.js';
export { JsExtractor } from './extractor/js-extractor.js';
export type { JsExtractorConfig } from './extractor/js-extractor.js';
export { GraphWriter } from './extractor/graph-writer.js';
export type { GraphWriterDeps } from './extractor/graph-writer.js';

export { PassRunner } from './pass-runner.js';
export type {
  Pass,
  PassContext,
  PassRegisterOptions,
  PassRunnerConfig,
  PassRunnerDeps,
  PassRunnerInput,
  PassStats,
} from './pass-runner.js';

export {
  DocumentStorePassRunHistoryStore,
  NoopPassRunHistoryStore,
} from './pass-run-history-store.js';
export type {
  PassRunHistoryStore,
  PassRunRecord,
  PassRunStatus,
} from './pass-run-history-store.js';

// Documented-but-unimplemented analysis passes. See docs/graph/.
export * from './analysis/index.js';
