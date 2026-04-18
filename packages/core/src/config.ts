import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

export interface DocumentsConfig {
  provider: 's3' | 'filesystem';
  bucket?: string;
  prefix?: string;
  region?: string;
  rootDir?: string;
  sqsQueueUrl?: string;
}

export interface SemanticIndexConfig {
  provider: 'bedrock' | 'pgvector' | 'sqlite' | 'none';
  knowledgeBaseId?: string;
  dataSourceId?: string;
  region?: string;
}

export interface GraphConfig {
  bolt: string;
  username?: string;
  password?: string;
  database?: string;
  maxPoolSize?: number;
}

export interface ConceptExtractionConfig {
  enabled: boolean;
  provider: 'bedrock' | 'none';
  model: string;
  embeddingModel: string;
  similarityThreshold: number;
  minDocChars: number;
  region?: string;
}

export interface EnrichmentConfig {
  conceptExtraction: ConceptExtractionConfig;
}

export interface SummarizationEmbeddingConfig {
  /** Embedding model identifier, e.g. `amazon.titan-embed-text-v2:0`. */
  model: string;
  /** Must match the dimensionality produced by `model`. Drives the vector indexes. */
  dimensions: number;
}

export interface SummarizationConfig {
  /** Model used for navigation/tool-use. */
  navigationModel: string;
  /** Model used to produce canonical summaries. */
  summaryModel: string;
  embedding: SummarizationEmbeddingConfig;
  /** Cost ceiling (USD) for a single summarization run. 0 disables the check. */
  maxRunCostUSD: number;
}

export interface SourceAccessConfig {
  enabled: boolean;
  cloneRoot: string;
  fetchIntervalSeconds: number;
  sshKeyPath?: string;
}

export interface PassSettings {
  enabled: boolean;
  config?: Record<string, unknown>;
}

export type PassFailurePolicy = 'continue' | 'abort';

export interface OrchestratorConfig {
  enabled: boolean;
  maxConcurrentRepos: number;
  /** Default per-pass timeout applied when a pass registers without an explicit timeout. */
  passTimeoutSeconds: number;
  /** On pass error: `continue` runs siblings and records the failure; `abort` halts the run. */
  passFailurePolicy: PassFailurePolicy;
  /** Per-pass enable flag + opaque config bag, keyed by pass name. */
  passes: Record<string, PassSettings>;
}

export interface BaseExtractorConfig {
  ignorePatterns: string[];
  maxFileSizeBytes: number;
}

export interface CoreConfig {
  system: {
    name: string;
    environment: 'production' | 'staging' | 'development';
  };
  storage: {
    documents: DocumentsConfig;
    semanticIndex: SemanticIndexConfig;
    graph: GraphConfig;
  };
  mcp: {
    port: number;
  };
  observability: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
  enrichment: EnrichmentConfig;
  summarization: SummarizationConfig;
  sourceAccess: SourceAccessConfig;
  orchestrator: OrchestratorConfig;
  baseExtractor: BaseExtractorConfig;
}

const DEFAULT_CONFIG: CoreConfig = {
  system: { name: 'kepler', environment: 'development' },
  storage: {
    documents: { provider: 'filesystem', rootDir: './docs-store' },
    semanticIndex: { provider: 'none' },
    graph: { bolt: 'bolt://localhost:7687' },
  },
  mcp: { port: 8080 },
  observability: { logLevel: 'info' },
  enrichment: {
    conceptExtraction: {
      enabled: false,
      provider: 'none',
      model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      embeddingModel: 'amazon.titan-embed-text-v2:0',
      similarityThreshold: 0.88,
      minDocChars: 400,
    },
  },
  summarization: {
    navigationModel: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    summaryModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    embedding: {
      model: 'amazon.titan-embed-text-v2:0',
      dimensions: 1536,
    },
    maxRunCostUSD: 0,
  },
  sourceAccess: {
    enabled: false,
    cloneRoot: '/var/repos',
    fetchIntervalSeconds: 60,
  },
  orchestrator: {
    enabled: true,
    maxConcurrentRepos: 1,
    passTimeoutSeconds: 300,
    passFailurePolicy: 'continue',
    passes: {},
  },
  baseExtractor: {
    ignorePatterns: ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache'],
    maxFileSizeBytes: 500_000,
  },
};

export function loadConfig(path?: string): CoreConfig {
  const configPath = path ?? process.env['KEPLER_CONFIG_PATH'] ?? '/etc/project/config.yaml';

  let raw: Record<string, unknown>;
  try {
    const contents = readFileSync(configPath, 'utf8');
    raw = parseYaml(contents) as Record<string, unknown>;
  } catch {
    return DEFAULT_CONFIG;
  }

  return mergeConfig(DEFAULT_CONFIG, raw);
}

function mergeOrchestrator(
  defaults: OrchestratorConfig,
  raw: Partial<OrchestratorConfig> | undefined,
): OrchestratorConfig {
  if (!raw) return { ...defaults, passes: { ...defaults.passes } };
  const passesRaw = (raw as { passes?: unknown }).passes;
  const mergedPasses: Record<string, PassSettings> = { ...defaults.passes };
  if (passesRaw && typeof passesRaw === 'object' && !Array.isArray(passesRaw)) {
    for (const [name, settings] of Object.entries(passesRaw as Record<string, unknown>)) {
      if (!settings || typeof settings !== 'object') continue;
      const s = settings as Partial<PassSettings>;
      mergedPasses[name] = {
        enabled: s.enabled !== false,
        ...(s.config === undefined ? {} : { config: s.config }),
      };
    }
  }
  return {
    enabled: raw.enabled ?? defaults.enabled,
    maxConcurrentRepos: raw.maxConcurrentRepos ?? defaults.maxConcurrentRepos,
    passTimeoutSeconds: raw.passTimeoutSeconds ?? defaults.passTimeoutSeconds,
    passFailurePolicy: raw.passFailurePolicy ?? defaults.passFailurePolicy,
    passes: mergedPasses,
  };
}

function mergeSummarization(
  defaults: SummarizationConfig,
  raw: Partial<SummarizationConfig> | undefined,
): SummarizationConfig {
  if (!raw) return { ...defaults, embedding: { ...defaults.embedding } };
  return {
    navigationModel: raw.navigationModel ?? defaults.navigationModel,
    summaryModel: raw.summaryModel ?? defaults.summaryModel,
    embedding: {
      ...defaults.embedding,
      ...(raw.embedding as Partial<SummarizationEmbeddingConfig> | undefined),
    },
    maxRunCostUSD: raw.maxRunCostUSD ?? defaults.maxRunCostUSD,
  };
}

function mergeConfig(defaults: CoreConfig, raw: Record<string, unknown>): CoreConfig {
  const system = raw['system'] as Partial<CoreConfig['system']> | undefined;
  const storage = raw['storage'] as Record<string, unknown> | undefined;
  const mcp = raw['mcp'] as Partial<CoreConfig['mcp']> | undefined;
  const observability = raw['observability'] as Partial<CoreConfig['observability']> | undefined;
  const enrichment = raw['enrichment'] as Record<string, unknown> | undefined;
  const summarization = raw['summarization'] as Partial<SummarizationConfig> | undefined;
  const sourceAccess = raw['sourceAccess'] as Partial<SourceAccessConfig> | undefined;
  const orchestrator = raw['orchestrator'] as Partial<OrchestratorConfig> | undefined;
  const baseExtractor = raw['baseExtractor'] as Partial<BaseExtractorConfig> | undefined;

  return {
    system: { ...defaults.system, ...system },
    storage: {
      documents: {
        ...defaults.storage.documents,
        ...(storage?.['documents'] as Partial<DocumentsConfig> | undefined),
      },
      semanticIndex: {
        ...defaults.storage.semanticIndex,
        ...(storage?.['semanticIndex'] as Partial<SemanticIndexConfig> | undefined),
      },
      graph: {
        ...defaults.storage.graph,
        ...(storage?.['graph'] as Partial<GraphConfig> | undefined),
      },
    },
    mcp: { ...defaults.mcp, ...mcp },
    observability: { ...defaults.observability, ...observability },
    enrichment: {
      conceptExtraction: {
        ...defaults.enrichment.conceptExtraction,
        ...(enrichment?.['conceptExtraction'] as Partial<ConceptExtractionConfig> | undefined),
      },
    },
    summarization: mergeSummarization(defaults.summarization, summarization),
    sourceAccess: { ...defaults.sourceAccess, ...sourceAccess },
    orchestrator: mergeOrchestrator(defaults.orchestrator, orchestrator),
    baseExtractor: { ...defaults.baseExtractor, ...baseExtractor },
  };
}
