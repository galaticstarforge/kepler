import type { DocumentStore } from '@kepler/shared';

import type { DocumentsConfig } from '../config.js';

import { FilesystemDocumentStore } from './filesystem-document-store.js';
import { S3DocumentStore } from './s3-document-store.js';

export function createDocumentStore(config: DocumentsConfig): DocumentStore {
  switch (config.provider) {
    case 's3': {
      if (!config.bucket) throw new Error('storage.documents.bucket is required for S3 provider');
      return new S3DocumentStore({
        bucket: config.bucket,
        prefix: config.prefix ?? 'docs/',
        region: config.region ?? 'us-east-1',
        sqsQueueUrl: config.sqsQueueUrl,
      });
    }
    case 'filesystem': {
      return new FilesystemDocumentStore(config.rootDir ?? './docs-store');
    }
    default: {
      throw new Error(`Unknown document store provider: ${config.provider as string}`);
    }
  }
}
