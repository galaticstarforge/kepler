import { GetKnowledgeBaseCommand } from '@aws-sdk/client-bedrock-agent';
import { StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import type {
  IndexableDocument,
  IndexStatus,
  SearchOptions,
  SearchResult,
  SemanticIndex,
} from '@kepler/shared';
import { SemanticIndexError } from '@kepler/shared';

import { getBedrockAgentClient, getBedrockAgentRuntimeClient } from '../aws-clients.js';
import { createLogger } from '../logger.js';

const log = createLogger('bedrock-semantic-index');

export interface BedrockSemanticIndexConfig {
  knowledgeBaseId: string;
  region: string;
  dataSourceId?: string;
}

export class BedrockSemanticIndex implements SemanticIndex {
  private readonly agentClient;
  private readonly runtimeClient;
  private readonly config: BedrockSemanticIndexConfig;

  constructor(config: BedrockSemanticIndexConfig) {
    this.config = config;
    this.agentClient = getBedrockAgentClient(config.region);
    this.runtimeClient = getBedrockAgentRuntimeClient(config.region);
  }

  /**
   * Upsert triggers a KB ingestion job to re-sync from S3. The actual
   * document content is written to S3 by the DocumentStore — this just
   * tells Bedrock KB to pick up changes.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async upsert(doc: IndexableDocument): Promise<void> {
    if (!this.config.dataSourceId) {
      log.debug('no dataSourceId configured — skipping ingestion trigger');
      return;
    }

    try {
      await this.agentClient.send(
        new StartIngestionJobCommand({
          knowledgeBaseId: this.config.knowledgeBaseId,
          dataSourceId: this.config.dataSourceId,
        }),
      );
      log.info('triggered ingestion job');
    } catch (error: unknown) {
      log.warn('failed to trigger ingestion job', { error: String(error) });
      // Non-fatal: the KB will eventually sync on its own schedule.
    }
  }

  /**
   * Delete triggers a re-sync. The document has already been removed
   * from S3 by the DocumentStore.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async delete(path: string): Promise<void> {
    if (!this.config.dataSourceId) return;

    try {
      await this.agentClient.send(
        new StartIngestionJobCommand({
          knowledgeBaseId: this.config.knowledgeBaseId,
          dataSourceId: this.config.dataSourceId,
        }),
      );
    } catch (error: unknown) {
      log.warn('failed to trigger ingestion job on delete', { error: String(error) });
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    try {
      const resp = await this.runtimeClient.send(
        new RetrieveCommand({
          knowledgeBaseId: this.config.knowledgeBaseId,
          retrievalQuery: { text: query },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: options?.limit ?? 10,
            },
          },
        }),
      );

      const results: SearchResult[] = [];
      for (const item of resp.retrievalResults ?? []) {
        const score = item.score ?? 0;
        if (options?.minScore && score < options.minScore) continue;

        const uri = item.location?.s3Location?.uri ?? '';
        const docPath = this.extractDocPath(uri);
        const snippet = item.content?.text ?? '';

        const metadata: Record<string, string> = {};
        if (item.metadata) {
          for (const [k, v] of Object.entries(item.metadata)) {
            if (typeof v === 'string') metadata[k] = v;
            else if (v && typeof v === 'object' && 'value' in v) {
              metadata[k] = String((v as { value: unknown }).value);
            }
          }
        }

        // Apply client-side metadata filters.
        if (options?.filter) {
          let matches = true;
          for (const [k, v] of Object.entries(options.filter)) {
            if (metadata[k] !== v) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }

        results.push({ path: docPath, score, snippet, metadata });
      }

      return results;
    } catch (error: unknown) {
      throw new SemanticIndexError('Bedrock search failed', error);
    }
  }

  async status(): Promise<IndexStatus> {
    try {
      const resp = await this.agentClient.send(
        new GetKnowledgeBaseCommand({
          knowledgeBaseId: this.config.knowledgeBaseId,
        }),
      );

      const kb = resp.knowledgeBase;
      return {
        provider: 'bedrock',
        documentCount: 0, // KB API doesn't expose document count directly.
        lastSyncedAt: kb?.updatedAt ?? null,
        healthy: kb?.status === 'ACTIVE',
      };
    } catch (error: unknown) {
      throw new SemanticIndexError('Failed to get Bedrock KB status', error);
    }
  }

  private extractDocPath(s3Uri: string): string {
    // S3 URIs look like: s3://bucket/prefix/path/to/doc.md
    const match = s3Uri.match(/s3:\/\/[^/]+\/(.+)/);
    return match?.[1] ?? s3Uri;
  }
}
