import type { DocumentMetadata, DocumentStore } from '@keplerforge/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { GraphClient } from '../graph/graph-client.js';
import {
  meetsVectorIndexMinimum,
  MIN_NEO4J_VERSION_FOR_VECTOR,
  vectorIndexDropStatements,
  vectorIndexStatements,
} from '../graph/schema.js';
import type { Logger } from '../logger.js';
import { createLogger } from '../logger.js';

export const EMBEDDING_MODEL_META_PATH = '_meta/embedding-model.yaml';

export interface EmbeddingModelRecord {
  model: string;
  dimensions: number;
  updatedAt: string;
}

export interface EmbeddingModelRatchetDeps {
  graph: GraphClient;
  store: DocumentStore;
  logger?: Logger;
}

export interface EmbeddingModelRatchetResult {
  /** `'installed'` on first run, `'rotated'` when the model changed, `'unchanged'` otherwise. */
  action: 'installed' | 'rotated' | 'unchanged';
  previous: EmbeddingModelRecord | null;
  current: EmbeddingModelRecord;
  neo4jVersion: string;
}

/**
 * Applies or rotates the SymbolSummary/CommunitySummary vector indexes to
 * match the configured embedding model. The live model + dimension count
 * is tracked in `_meta/embedding-model.yaml` in the document store so
 * that successive boots can detect model changes.
 *
 * Rules:
 *  - Fail fast if Neo4j is older than 5.11 (vector indexes are unsupported).
 *  - First run: create both vector indexes, write the meta record.
 *  - Model unchanged: leave indexes as-is.
 *  - Model changed: drop both indexes, recreate at the new dimension
 *    count, rewrite the meta record, log exactly once.
 *
 * The caller is expected to poll `/ready` for the `ONLINE` state; index
 * builds are asynchronous in Neo4j.
 */
export class EmbeddingModelRatchet {
  private readonly log: Logger;

  constructor(private readonly deps: EmbeddingModelRatchetDeps) {
    this.log = deps.logger ?? createLogger('embedding-model-ratchet');
  }

  async apply(config: { model: string; dimensions: number }): Promise<EmbeddingModelRatchetResult> {
    if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
      throw new Error(
        `embedding dimensions must be a positive integer (got ${String(config.dimensions)})`,
      );
    }
    if (!config.model || typeof config.model !== 'string') {
      throw new Error('embedding model must be a non-empty string');
    }

    const neo4jVersion = await this.deps.graph.serverVersion();
    if (!meetsVectorIndexMinimum(neo4jVersion)) {
      throw new Error(
        `Neo4j ${neo4jVersion} does not support native vector indexes; ` +
          `upgrade to ${MIN_NEO4J_VERSION_FOR_VECTOR}+`,
      );
    }

    const previous = await this.readMeta();
    const now = new Date().toISOString();
    const current: EmbeddingModelRecord = {
      model: config.model,
      dimensions: config.dimensions,
      updatedAt: now,
    };

    if (!previous) {
      await this.deps.graph.applySchema(vectorIndexStatements(config.dimensions));
      await this.writeMeta(current);
      this.log.info('embedding model installed', {
        model: config.model,
        dimensions: config.dimensions,
        neo4jVersion,
      });
      return { action: 'installed', previous: null, current, neo4jVersion };
    }

    if (previous.model === config.model && previous.dimensions === config.dimensions) {
      // Ensure indexes exist (e.g. after a Neo4j volume reset) without logging rotation.
      await this.deps.graph.applySchema(vectorIndexStatements(config.dimensions));
      return { action: 'unchanged', previous, current: previous, neo4jVersion };
    }

    this.log.info('embedding model rotated — dropping and recreating vector indexes', {
      previousModel: previous.model,
      previousDimensions: previous.dimensions,
      nextModel: config.model,
      nextDimensions: config.dimensions,
      neo4jVersion,
    });
    await this.deps.graph.applySchema(vectorIndexDropStatements());
    await this.deps.graph.applySchema(vectorIndexStatements(config.dimensions));
    await this.writeMeta(current);
    return { action: 'rotated', previous, current, neo4jVersion };
  }

  async readMeta(): Promise<EmbeddingModelRecord | null> {
    const doc = await this.deps.store.get(EMBEDDING_MODEL_META_PATH);
    if (!doc) return null;
    const raw = doc.content.toString('utf8');
    try {
      const parsed = parseYaml(raw) as Partial<EmbeddingModelRecord> | null;
      if (!parsed || typeof parsed.model !== 'string' || typeof parsed.dimensions !== 'number') {
        this.log.warn('embedding-model meta file is malformed; treating as uninstalled');
        return null;
      }
      return {
        model: parsed.model,
        dimensions: parsed.dimensions,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      };
    } catch (error) {
      this.log.warn('embedding-model meta file failed to parse; treating as uninstalled', {
        error: String(error),
      });
      return null;
    }
  }

  private async writeMeta(record: EmbeddingModelRecord): Promise<void> {
    const body = stringifyYaml(record);
    const buf = Buffer.from(body, 'utf8');
    const metadata: DocumentMetadata = {
      contentType: 'application/yaml',
      contentLength: buf.byteLength,
      lastModified: new Date(),
      custom: {},
    };
    await this.deps.store.put(EMBEDDING_MODEL_META_PATH, buf, metadata);
  }
}
