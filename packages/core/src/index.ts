import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { TemplateManager } from './docs/template-manager.js';
import { ConceptExtractor } from './enrichment/concept-extractor.js';
import { ConceptStore } from './enrichment/concept-store.js';
import { EnrichmentRunner } from './enrichment/enrichment-runner.js';
import { BedrockLlmClient } from './enrichment/llm/bedrock-llm-client.js';
import { createLlmClient } from './enrichment/llm/llm-factory.js';
import { createGraphClient } from './graph/graph-client-factory.js';
import {
  CORE_INDEX_STATEMENTS,
  meetsVectorIndexMinimum,
  MIN_NEO4J_VERSION_FOR_VECTOR,
} from './graph/schema.js';
import {
  ArchitecturalLayerPass,
  BehavioralEdgesWriter,
  BoundedContextPass,
  type BoundedContextDeclaration,
  GitVolatilityPass,
  GovernsEdgesPass,
  PublicApiPass,
  StructuralMetricsPass,
  SymbolContentHashPass,
} from './indexer/analysis/index.js';
import { DocumentStorePassRunHistoryStore, Orchestrator, PassRunner } from './indexer/index.js';
import { createLogger, setLogLevel } from './logger.js';
import { AuthStore } from './mcp/auth-store.js';
import { McpRouter } from './mcp/mcp-router.js';
import { RateLimiter } from './mcp/rate-limiter.js';
import { GitRepoWatcher } from './repos/git-repo-watcher.js';
import { loadReposConfig } from './repos/repos-config.js';
import { EmbeddingModelRatchet } from './semantic/embedding-model-ratchet.js';
import { createSemanticIndex } from './semantic/semantic-index-factory.js';
import { VectorIndexReadiness } from './semantic/vector-index-readiness.js';
import { createHttpServer } from './server.js';
import { createDocumentStore } from './storage/document-store-factory.js';
import { SummarizationAgent } from './summarization/agent.js';
import { SummarizationScheduler } from './summarization/scheduler.js';
import { GitSourceAccess } from './summarization/source-access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const VERSION = loadVersion();
const DEPLOYMENT_NAME = process.env['KEPLER_DEPLOYMENT_NAME'] || '';
const REGION = process.env['KEPLER_REGION'] || '';

const log = createLogger('core');

// Load configuration.
const config = loadConfig();
setLogLevel(config.observability.logLevel);

const PORT = config.mcp.port;

// Initialize storage subsystems.
const store = createDocumentStore(config.storage.documents);
const index = createSemanticIndex(config.storage.semanticIndex);

// Neo4j graph client — connect and apply canonical indexes before accepting traffic.
const graph = createGraphClient(config.storage.graph);
let neo4jVersion = '';
try {
  await graph.connect();
  log.info('neo4j connected', { bolt: config.storage.graph.bolt });
  neo4jVersion = await graph.serverVersion();
  if (!meetsVectorIndexMinimum(neo4jVersion)) {
    throw new Error(
      `Neo4j ${neo4jVersion} does not support native vector indexes; ` +
        `upgrade to ${MIN_NEO4J_VERSION_FOR_VECTOR}+`,
    );
  }
  log.info('neo4j version verified', { version: neo4jVersion });
  await graph.applySchema(CORE_INDEX_STATEMENTS);
  log.info('neo4j schema applied', { statements: CORE_INDEX_STATEMENTS.length });
} catch (error) {
  log.error('neo4j startup failed', { bolt: config.storage.graph.bolt, error: String(error) });
  process.exit(1);
}

// Apply the embedding-model ratchet: installs or rotates vector indexes
// based on the configured model + dimensions, persisted to the doc store.
const embeddingRatchet = new EmbeddingModelRatchet({ graph, store });
try {
  const ratchetResult = await embeddingRatchet.apply(config.summarization.embedding);
  log.info('vector indexes ensured', {
    action: ratchetResult.action,
    model: ratchetResult.current.model,
    dimensions: ratchetResult.current.dimensions,
  });
} catch (error) {
  log.error('vector index setup failed', { error: String(error) });
  process.exit(1);
}

const vectorIndexReadiness = new VectorIndexReadiness({ graph });

const templates = new TemplateManager(store);

// Install default templates on startup.
templates.ensureDefaultTemplates().catch((error) => {
  log.warn('failed to install default templates', { error: String(error) });
});

// Enrichment pipeline.
const conceptStore = new ConceptStore(store);
const llm = createLlmClient(
  config.enrichment.conceptExtraction,
  config.storage.semanticIndex.region ?? REGION,
);
const conceptExtractor = new ConceptExtractor(llm);
const enrichmentRunner = new EnrichmentRunner({
  store,
  conceptStore,
  extractor: conceptExtractor,
  llm,
  config: config.enrichment.conceptExtraction,
  graph,
});

// Git repo watcher (optional; activates when repos.yaml present and sourceAccess.enabled).
let repoWatcher: GitRepoWatcher | null = null;
let loadedReposConfig: ReturnType<typeof loadReposConfig> = null;
if (config.sourceAccess.enabled) {
  try {
    loadedReposConfig = loadReposConfig();
    if (loadedReposConfig && loadedReposConfig.repos.length > 0) {
      repoWatcher = new GitRepoWatcher({
        config: config.sourceAccess,
        repos: loadedReposConfig,
        logger: createLogger('git-repo-watcher'),
      });
      repoWatcher.start().catch((error) => {
        log.error('git repo watcher failed to start', { error: String(error) });
      });
    }
  } catch (error) {
    log.error('failed to load repos.yaml', { error: String(error) });
  }
}

function boundedContextDeclarationsFor(repo: string): BoundedContextDeclaration[] {
  const entry = loadedReposConfig?.repos.find((r) => r.name === repo);
  if (!entry) return [];
  return entry.boundedContexts.map((bc, index) => ({
    contextId: bc.id,
    name: bc.name ?? bc.id,
    repo,
    description: bc.description ?? '',
    patterns: bc.paths,
    declarationOrder: index,
  }));
}

// Code indexing orchestrator (optional; activates when source access and orchestrator are enabled).
let orchestrator: Orchestrator | null = null;
if (config.sourceAccess.enabled && config.orchestrator.enabled && repoWatcher) {
  const passRunner = new PassRunner({
    graph,
    config: {
      passTimeoutSeconds: config.orchestrator.passTimeoutSeconds,
      passFailurePolicy: config.orchestrator.passFailurePolicy,
      passes: config.orchestrator.passes,
    },
    historyStore: new DocumentStorePassRunHistoryStore(store),
    logger: createLogger('pass-runner'),
  });
  passRunner.register(new SymbolContentHashPass({ graph }), {});
  passRunner.register(new StructuralMetricsPass({ graph }), {
    dependsOn: ['symbol-content-hash'],
  });
  passRunner.register(new BehavioralEdgesWriter({ graph }), {
    dependsOn: ['symbol-content-hash'],
  });
  passRunner.register(new GitVolatilityPass({ graph }), {});
  passRunner.register(new PublicApiPass({ graph }), {});
  passRunner.register(new ArchitecturalLayerPass({ graph }), {});
  passRunner.register(
    new BoundedContextPass({
      graph,
      declarationsFor: (repo) => boundedContextDeclarationsFor(repo),
    }),
    {},
  );
  passRunner.register(new GovernsEdgesPass({ graph, store }), {
    dependsOn: ['symbol-content-hash'],
  });

  orchestrator = new Orchestrator({
    watcher: repoWatcher,
    graph,
    config: config.orchestrator,
    extractorConfig: config.baseExtractor,
    passRunner,
    logger: createLogger('orchestrator'),
  });
  orchestrator.start();
}

// Summarization agent (requires source access + LLM provider).
let summarizationAgent: SummarizationAgent | null = null;
let summarizationScheduler: SummarizationScheduler | null = null;
if (config.sourceAccess.enabled && config.enrichment.conceptExtraction.provider !== 'none') {
  const sourceAccess = new GitSourceAccess(config.sourceAccess.cloneRoot);
  const summarizationRegion = config.storage.semanticIndex.region ?? REGION;
  const navigationLlm = new BedrockLlmClient({
    region: summarizationRegion,
    completionModel: config.summarization.navigationModel,
    embeddingModel: config.summarization.embedding.model,
  });
  const summaryLlm = new BedrockLlmClient({
    region: summarizationRegion,
    completionModel: config.summarization.summaryModel,
    embeddingModel: config.summarization.embedding.model,
  });
  summarizationAgent = new SummarizationAgent({
    graph,
    store,
    sourceAccess,
    navigationLlm,
    summaryLlm,
    logger: createLogger('summarization-agent'),
    priorityWeights: config.summarization.priorityWeights,
  });
  summarizationScheduler = new SummarizationScheduler({
    agent: summarizationAgent,
    logger: createLogger('summarization-scheduler'),
  });
  if (loadedReposConfig && loadedReposConfig.repos.length > 0) {
    const firstRepo = loadedReposConfig.repos[0]!;
    summarizationScheduler.start({
      scheduleMinutes: config.summarization.scheduleMinutes,
      agentConfig: {
        repo: firstRepo.name,
        mode: 'incremental',
        embeddingModel: config.summarization.embedding.model,
        maxRunCostUSD: config.summarization.maxRunCostUSD,
      },
    });
  }
} else {
  // SourceAccess still needed by the no-op path for the handler context.
  // Nothing to wire.
}

// Auth store and rate limiter (no-ops when auth is disabled).
const authStore = new AuthStore(config.auth);
const rateLimiter = new RateLimiter(config.rateLimits);

// Pass run history store for admin.passRunHistory.
const passRunHistoryStore = new DocumentStorePassRunHistoryStore(store);

// Build the OrchestratorHandle for admin tools (null when orchestrator is not running).
const _orch = orchestrator;
const orchestratorHandle = _orch
  ? {
      inFlightRepos: () => _orch.inFlightRepos(),
      configuredRepos: () => _orch.configuredRepos(),
    }
  : null;

// Create MCP router with handler context.
const router = new McpRouter({
  store,
  index,
  graph,
  templates,
  conceptStore,
  enrichmentRunner,
  logger: createLogger('mcp'),
  vectorIndexReadiness,
  passRunHistory: passRunHistoryStore,
  orchestrator: orchestratorHandle,
  summarizationAgent,
  summarizationEmbeddingModel: config.summarization.embedding.model,
  maxRunCostUSD: config.summarization.maxRunCostUSD,
});

// Create and start HTTP server.
const server = createHttpServer({
  version: VERSION,
  port: PORT,
  deploymentName: DEPLOYMENT_NAME,
  router,
  logger: createLogger('http'),
  authStore,
  rateLimiter,
  summarizationAgent,
  readinessProbe: async () => {
    const snapshot = await vectorIndexReadiness.snapshot();
    return {
      ready: snapshot.ready,
      details: {
        neo4jVersion,
        vectorIndexes: snapshot.indexes,
        checkedAt: snapshot.checkedAt,
      },
    };
  },
});

function shutdown(signal: string): void {
  log.info('shutdown', { signal });
  summarizationScheduler?.stop();
  orchestrator?.stop();
  repoWatcher?.stop();
  server.close(() => {
    graph.close().finally(() => process.exit(0));
  });
  setTimeout(() => {
    log.warn('forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  log.info('server started', {
    version: VERSION,
    port: PORT,
    deploymentName: DEPLOYMENT_NAME,
    region: REGION,
    documentProvider: config.storage.documents.provider,
    semanticProvider: config.storage.semanticIndex.provider,
    graphBolt: config.storage.graph.bolt,
    tools: router.listTools(),
  });
});

// Re-export public API for programmatic use.
export { createDocumentStore } from './storage/document-store-factory.js';
export { createSemanticIndex } from './semantic/semantic-index-factory.js';
export {
  GraphClient,
  createGraphClient,
  CORE_INDEX_STATEMENTS,
  VECTOR_INDEX_NAMES,
  MIN_NEO4J_VERSION_FOR_VECTOR,
  compareSemver,
  meetsVectorIndexMinimum,
  vectorIndexStatements,
  vectorIndexDropStatements,
} from './graph/index.js';
export type { GraphClientOptions, AccessMode, VectorIndexName } from './graph/index.js';
export {
  EmbeddingModelRatchet,
  EMBEDDING_MODEL_META_PATH,
  VectorIndexReadiness,
} from './semantic/index.js';
export type {
  EmbeddingModelRatchetDeps,
  EmbeddingModelRatchetResult,
  EmbeddingModelRecord,
  VectorIndexReadinessDeps,
  VectorIndexReadinessSnapshot,
  VectorIndexState,
} from './semantic/index.js';
export { McpRouter } from './mcp/mcp-router.js';
export { TemplateManager } from './docs/template-manager.js';
export { parseFrontmatter } from './docs/frontmatter-parser.js';
export { stripMarkdown } from './docs/markdown-stripper.js';
export { createLogger, setLogLevel } from './logger.js';
export { loadConfig } from './config.js';
export { GitRepoWatcher } from './repos/git-repo-watcher.js';
export { loadReposConfig, ReposConfigError } from './repos/repos-config.js';
export type { RepoEntry, ReposConfig, ReposDefaults } from './repos/repos-config.js';
export type { RepoUpdateEvent, RepoUpdateListener } from './repos/git-repo-watcher.js';
export {
  Orchestrator,
  FileDiscovery,
  JsExtractor,
  GraphWriter,
  PassRunner,
  DocumentStorePassRunHistoryStore,
  NoopPassRunHistoryStore,
} from './indexer/index.js';
export type {
  Pass,
  PassContext,
  PassRegisterOptions,
  PassRunnerConfig,
  PassRunnerDeps,
  PassRunnerInput,
  PassStats,
  PassRunHistoryStore,
  PassRunRecord,
  PassRunStatus,
} from './indexer/index.js';
export {
  ConceptExtractor,
  ConceptStore,
  EnrichmentRunner,
  BedrockLlmClient,
  NoopLlmClient,
  createLlmClient,
  slugify,
  cosine,
  encodeEmbedding,
  decodeEmbedding,
} from './enrichment/index.js';
