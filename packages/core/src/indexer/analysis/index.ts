export { NotImplementedError } from './errors.js';

export { StructuralMetricsPass } from './structural-metrics.js';
export type {
  StructuralMetricsConfig,
  StructuralMetricsDeps,
  StructuralMetricsStats,
} from './structural-metrics.js';

export { GitVolatilityPass } from './git-volatility.js';
export type {
  FileVolatility,
  GitVolatilityConfig,
  GitVolatilityDeps,
  GitVolatilityStats,
} from './git-volatility.js';

export { ArchitecturalLayerPass } from './architectural-layer.js';
export type {
  ArchitecturalLayerName,
  LayerClassificationConfig,
  LayerClassificationDeps,
  LayerClassificationStats,
  LayerRule,
} from './architectural-layer.js';

export { BoundedContextPass } from './bounded-context.js';
export type {
  BoundedContextConfig,
  BoundedContextDeclaration,
  BoundedContextDeps,
  BoundedContextStats,
} from './bounded-context.js';

export { PublicApiPass } from './public-api.js';
export type { PublicApiConfig, PublicApiDeps, PublicApiStats } from './public-api.js';

export { SemanticSummaryPass } from './semantic-summary.js';
export type {
  CommunitySummary,
  SummarizationStats,
  SummaryCoverageFlag,
  SummaryTier,
  SymbolSummary,
  SymbolSummaryConfig,
  SymbolSummaryDeps,
} from './semantic-summary.js';

export { BehavioralEdgesWriter } from './behavioral-edges.js';
export type {
  BehavioralEdgesConfig,
  BehavioralEdgesDeps,
  BehavioralEdgesStats,
  CallsServiceEdge,
  CatchesEdge,
  ConfigAccessPattern,
  ConfigConfidence,
  CoverageKind,
  ReadsConfigEdge,
  TestAssertsEdge,
  ThrowConfidence,
  ThrowsEdge,
} from './behavioral-edges.js';

export { GovernsEdgesPass } from './governs-edges.js';
export type {
  GovernsDeclaration,
  GovernsEdgesConfig,
  GovernsEdgesDeps,
  GovernsEdgesStats,
} from './governs-edges.js';

export { SymbolContentHashPass } from './content-hash.js';
export type { ContentHashConfig, ContentHashDeps, ContentHashStats } from './content-hash.js';
