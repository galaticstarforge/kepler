export { GitSourceAccess, NoopSourceAccess, MAX_FILE_READ_LINES } from './source-access.js';
export type { SourceAccess, SourceReadOptions } from './source-access.js';

export { RunLogger } from './run-logger.js';
export type { RunLogEntry } from './run-logger.js';

export { SummarizationAgent } from './agent.js';
export type {
  SummarizationAgentConfig,
  SummarizationAgentDeps,
  SummarizationMode,
  SummarizationRunRecord,
  SummarizationRunStats,
  SummarizationRunStatus,
} from './agent.js';

export { SummarizationScheduler } from './scheduler.js';
export type {
  SummarizationSchedulerConfig,
  SummarizationSchedulerDeps,
} from './scheduler.js';

export {
  CommunityPriorityQueue,
  DEFAULT_PRIORITY_WEIGHTS,
  computePriorityScore,
} from './priority-queue.js';
export type { CommunityQueueEntry, PriorityWeights } from './priority-queue.js';

export type {
  CommunityResult,
  CommunityStub,
  CoverageReport,
  ExistingSummary,
  SummarizationToolContext,
  SummaryAssertions,
  SummaryPayload,
  SummaryTarget,
  SymbolDetail,
  SymbolStub,
  ValidationResult,
  ValidationStatus,
  WriteSummaryResult,
} from './tools.js';
