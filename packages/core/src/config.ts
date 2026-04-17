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

export interface SourceAccessConfig {
  enabled: boolean;
  cloneRoot: string;
  fetchIntervalSeconds: number;
  sshKeyPath?: string;
}

export interface OrchestratorConfig {
  enabled: boolean;
  maxConcurrentRepos: number;
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
  sourceAccess: {
    enabled: false,
    cloneRoot: '/var/repos',
    fetchIntervalSeconds: 60,
  },
  orchestrator: {
    enabled: true,
    maxConcurrentRepos: 1,
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

function mergeConfig(defaults: CoreConfig, raw: Record<string, unknown>): CoreConfig {
  const system = raw['system'] as Partial<CoreConfig['system']> | undefined;
  const storage = raw['storage'] as Record<string, unknown> | undefined;
  const mcp = raw['mcp'] as Partial<CoreConfig['mcp']> | undefined;
  const observability = raw['observability'] as Partial<CoreConfig['observability']> | undefined;
  const enrichment = raw['enrichment'] as Record<string, unknown> | undefined;
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
    sourceAccess: { ...defaults.sourceAccess, ...sourceAccess },
    orchestrator: { ...defaults.orchestrator, ...orchestrator },
    baseExtractor: { ...defaults.baseExtractor, ...baseExtractor },
  };
}
