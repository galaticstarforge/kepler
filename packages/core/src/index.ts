import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { TemplateManager } from './docs/template-manager.js';
import { ConceptExtractor } from './enrichment/concept-extractor.js';
import { ConceptStore } from './enrichment/concept-store.js';
import { EnrichmentRunner } from './enrichment/enrichment-runner.js';
import { createLlmClient } from './enrichment/llm/llm-factory.js';
import { createLogger, setLogLevel } from './logger.js';
import { McpRouter } from './mcp/mcp-router.js';
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
});

// Create MCP router with handler context.
const router = new McpRouter({
  store,
  index,
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
  server.close(() => {
    process.exit(0);
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
    tools: router.listTools(),
  });
});

// Re-export public API for programmatic use.
export { createDocumentStore } from './storage/document-store-factory.js';
export { createSemanticIndex } from './semantic/semantic-index-factory.js';
export { McpRouter } from './mcp/mcp-router.js';
export { TemplateManager } from './docs/template-manager.js';
export { parseFrontmatter } from './docs/frontmatter-parser.js';
export { stripMarkdown } from './docs/markdown-stripper.js';
export { createLogger, setLogLevel } from './logger.js';
export { loadConfig } from './config.js';
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
