import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { TemplateManager } from './docs/template-manager.js';
import { ConceptExtractor } from './enrichment/concept-extractor.js';
import { ConceptStore } from './enrichment/concept-store.js';
import { EnrichmentRunner } from './enrichment/enrichment-runner.js';
import { createLlmClient } from './enrichment/llm/llm-factory.js';
import { createGraphClient } from './graph/graph-client-factory.js';
import { CORE_INDEX_STATEMENTS } from './graph/schema.js';
import { DocumentStorePassRunHistoryStore, Orchestrator, PassRunner } from './indexer/index.js';
import { createLogger, setLogLevel } from './logger.js';
import { McpRouter } from './mcp/mcp-router.js';
import { GitRepoWatcher } from './repos/git-repo-watcher.js';
import { loadReposConfig } from './repos/repos-config.js';
import { createSemanticIndex } from './semantic/semantic-index-factory.js';
import { createHttpServer } from './server.js';
import { createDocumentStore } from './storage/document-store-factory.js';

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
try {
  await graph.connect();
  log.info('neo4j connected', { bolt: config.storage.graph.bolt });
  await graph.applySchema(CORE_INDEX_STATEMENTS);
  log.info('neo4j schema applied', { statements: CORE_INDEX_STATEMENTS.length });
} catch (error) {
  log.error('neo4j startup failed', { bolt: config.storage.graph.bolt, error: String(error) });
  process.exit(1);
}

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
if (config.sourceAccess.enabled) {
  try {
    const reposConfig = loadReposConfig();
    if (reposConfig && reposConfig.repos.length > 0) {
      repoWatcher = new GitRepoWatcher({
        config: config.sourceAccess,
        repos: reposConfig,
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
  // Phase A ships the runner itself. Individual passes are wired in phases B–F.

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

// Create MCP router with handler context.
const router = new McpRouter({
  store,
  index,
  graph,
  templates,
  conceptStore,
  enrichmentRunner,
  logger: createLogger('mcp'),
});

// Create and start HTTP server.
const server = createHttpServer({
  version: VERSION,
  port: PORT,
  deploymentName: DEPLOYMENT_NAME,
  router,
  logger: createLogger('http'),
});

function shutdown(signal: string): void {
  log.info('shutdown', { signal });
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
export { GraphClient, createGraphClient, CORE_INDEX_STATEMENTS } from './graph/index.js';
export type { GraphClientOptions, AccessMode } from './graph/index.js';
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
