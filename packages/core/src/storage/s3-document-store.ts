import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type {
  DocumentBytes,
  DocumentHead,
  DocumentMetadata,
  DocumentStore,
  DocumentStoreEvent,
  DocumentStoreEventType,
} from '@keplerforge/shared';
import { DocumentStoreError } from '@keplerforge/shared';

import { getS3Client, getSQSClient } from '../aws-clients.js';
import { createLogger } from '../logger.js';

const log = createLogger('s3-document-store');

export interface S3DocumentStoreConfig {
  bucket: string;
  prefix: string;
  region: string;
  sqsQueueUrl?: string;
}

function s3Key(prefix: string, docPath: string): string {
  const base = prefix.endsWith('/') ? prefix : prefix + '/';
  return base + docPath;
}

function docPathFromKey(prefix: string, key: string): string {
  const base = prefix.endsWith('/') ? prefix : prefix + '/';
  return key.startsWith(base) ? key.slice(base.length) : key;
}

function extractCustomMeta(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    result[k] = v;
  }
  return result;
}

export class S3DocumentStore implements DocumentStore {
  private readonly s3;
  private readonly sqs;
  private readonly config: S3DocumentStoreConfig;

  constructor(config: S3DocumentStoreConfig) {
    this.config = config;
    this.s3 = getS3Client(config.region);
    this.sqs = config.sqsQueueUrl ? getSQSClient(config.region) : null;
  }

  async get(docPath: string): Promise<DocumentBytes | null> {
    try {
      const resp = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key(this.config.prefix, docPath),
        }),
      );

      const body = await resp.Body?.transformToByteArray();
      if (!body) return null;

      const content = Buffer.from(body);
      const metadata: DocumentMetadata = {
        contentType: resp.ContentType ?? 'text/markdown',
        contentLength: resp.ContentLength ?? content.length,
        lastModified: resp.LastModified ?? new Date(),
        etag: resp.ETag,
        custom: extractCustomMeta(resp.Metadata),
      };

      return { content, metadata, etag: resp.ETag, lastModified: resp.LastModified };
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw new DocumentStoreError(`Failed to get document "${docPath}"`, error);
    }
  }

  async put(docPath: string, content: Buffer, metadata: DocumentMetadata): Promise<void> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key(this.config.prefix, docPath),
          Body: content,
          ContentType: metadata.contentType,
          Metadata: metadata.custom,
        }),
      );
    } catch (error: unknown) {
      throw new DocumentStoreError(`Failed to put document "${docPath}"`, error);
    }
  }

  async delete(docPath: string): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key(this.config.prefix, docPath),
        }),
      );
    } catch (error: unknown) {
      throw new DocumentStoreError(`Failed to delete document "${docPath}"`, error);
    }
  }

  async *list(prefix: string): AsyncIterable<DocumentHead> {
    const fullPrefix = s3Key(this.config.prefix, prefix);
    let continuationToken: string | undefined;

    do {
      let resp;
      try {
        resp = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: fullPrefix,
            ContinuationToken: continuationToken,
          }),
        );
      } catch (error: unknown) {
        throw new DocumentStoreError(`Failed to list documents under "${prefix}"`, error);
      }

      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        yield {
          path: docPathFromKey(this.config.prefix, obj.Key),
          metadata: {
            contentType: 'text/markdown',
            contentLength: obj.Size ?? 0,
            lastModified: obj.LastModified ?? new Date(),
            etag: obj.ETag,
            custom: {},
          },
        };
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async head(docPath: string): Promise<DocumentHead | null> {
    try {
      const resp = await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key(this.config.prefix, docPath),
        }),
      );

      return {
        path: docPath,
        metadata: {
          contentType: resp.ContentType ?? 'text/markdown',
          contentLength: resp.ContentLength ?? 0,
          lastModified: resp.LastModified ?? new Date(),
          etag: resp.ETag,
          custom: extractCustomMeta(resp.Metadata),
        },
      };
    } catch (error: unknown) {
      const name = (error as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw new DocumentStoreError(`Failed to head document "${docPath}"`, error);
    }
  }

  async *watch(): AsyncIterable<DocumentStoreEvent> {
    if (!this.sqs || !this.config.sqsQueueUrl) {
      log.warn('SQS queue URL not configured — watch() will not emit events');
      return;
    }

    while (true) {
      let resp;
      try {
        resp = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.sqsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        );
      } catch (error: unknown) {
        log.error('SQS receive failed', { error: String(error) });
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const msg of resp.Messages ?? []) {
        const event = this.parseS3Event(msg.Body);
        if (event) yield event;

        if (msg.ReceiptHandle) {
          try {
            await this.sqs.send(
              new DeleteMessageCommand({
                QueueUrl: this.config.sqsQueueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
          } catch (error: unknown) {
            log.error('SQS delete failed', { error: String(error) });
          }
        }
      }
    }
  }

  private parseS3Event(body: string | undefined): DocumentStoreEvent | null {
    if (!body) return null;
    try {
      const envelope = JSON.parse(body) as { detail?: { eventName?: string; object?: { key?: string } } };
      const detail = envelope.detail;
      if (!detail?.object?.key) return null;

      const key = detail.object.key;
      const docPath = docPathFromKey(this.config.prefix, key);

      let type: DocumentStoreEventType;
      const eventName = detail.eventName ?? '';
      if (eventName.includes('Put') || eventName.includes('Copy')) {
        type = 'created';
      } else if (eventName.includes('Delete')) {
        type = 'deleted';
      } else {
        type = 'updated';
      }

      return { type, path: docPath, timestamp: new Date() };
    } catch {
      log.warn('failed to parse S3 event', { body });
      return null;
    }
  }
}
