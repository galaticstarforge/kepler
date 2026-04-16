import { describe, it, expect, vi, beforeEach } from 'vitest';

import { S3DocumentStore } from '../src/storage/s3-document-store.js';

// Mock AWS clients module to prevent real AWS calls.
vi.mock('../src/aws-clients.js', () => {
  const mockSend = vi.fn();
  return {
    getS3Client: () => ({ send: mockSend }),
    getSQSClient: () => ({ send: vi.fn() }),
    resetClients: vi.fn(),
    __mockSend: mockSend,
  };
});

 
let mockSend: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const mod = await import('../src/aws-clients.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSend = (mod as any).__mockSend;
  mockSend.mockReset();
});

const config = { bucket: 'test-bucket', prefix: 'docs/', region: 'us-east-1' };

function makeStore() {
  return new S3DocumentStore(config);
}

function streamFrom(data: string) {
  return {
    transformToByteArray: async () => Buffer.from(data),
  };
}

describe('S3DocumentStore', () => {
  describe('get', () => {
    it('returns document bytes on success', async () => {
      mockSend.mockResolvedValueOnce({
        Body: streamFrom('# Hello'),
        ContentType: 'text/markdown',
        ContentLength: 7,
        LastModified: new Date('2026-01-01'),
        ETag: '"abc"',
        Metadata: { author: 'test' },
      });

      const store = makeStore();
      const result = await store.get('hello.md');

      expect(result).not.toBeNull();
      expect(result!.content.toString('utf8')).toBe('# Hello');
      expect(result!.metadata.contentType).toBe('text/markdown');
      expect(result!.metadata.custom['author']).toBe('test');
      expect(result!.etag).toBe('"abc"');
    });

    it('returns null on NoSuchKey', async () => {
      const error = new Error('not found');
      error.name = 'NoSuchKey';
      mockSend.mockRejectedValueOnce(error);

      const store = makeStore();
      const result = await store.get('missing.md');
      expect(result).toBeNull();
    });

    it('throws DocumentStoreError on other errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('network failure'));

      const store = makeStore();
      await expect(store.get('fail.md')).rejects.toThrow('Failed to get document');
    });
  });

  describe('put', () => {
    it('sends PutObjectCommand with correct params', async () => {
      mockSend.mockResolvedValueOnce({});

      const store = makeStore();
      await store.put('new.md', Buffer.from('content'), {
        contentType: 'text/markdown',
        contentLength: 7,
        lastModified: new Date(),
        custom: { tag: 'test' },
      });

      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0]![0];
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('docs/new.md');
      expect(cmd.input.ContentType).toBe('text/markdown');
      expect(cmd.input.Metadata).toEqual({ tag: 'test' });
    });
  });

  describe('delete', () => {
    it('sends DeleteObjectCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      const store = makeStore();
      await store.delete('old.md');

      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0]![0];
      expect(cmd.input.Key).toBe('docs/old.md');
    });
  });

  describe('head', () => {
    it('returns document head on success', async () => {
      mockSend.mockResolvedValueOnce({
        ContentType: 'text/markdown',
        ContentLength: 42,
        LastModified: new Date('2026-01-01'),
        ETag: '"xyz"',
        Metadata: {},
      });

      const store = makeStore();
      const head = await store.head('exists.md');

      expect(head).not.toBeNull();
      expect(head!.path).toBe('exists.md');
      expect(head!.metadata.contentLength).toBe(42);
    });

    it('returns null on NotFound', async () => {
      const error = new Error('not found');
      error.name = 'NotFound';
      mockSend.mockRejectedValueOnce(error);

      const store = makeStore();
      const head = await store.head('missing.md');
      expect(head).toBeNull();
    });
  });

  describe('list', () => {
    it('yields document heads from paginated results', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'docs/a.md', Size: 10, LastModified: new Date() }],
          IsTruncated: true,
          NextContinuationToken: 'token1',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'docs/b.md', Size: 20, LastModified: new Date() }],
          IsTruncated: false,
        });

      const store = makeStore();
      const items: string[] = [];
      for await (const head of store.list('')) {
        items.push(head.path);
      }

      expect(items).toEqual(['a.md', 'b.md']);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('watch', () => {
    it('returns immediately when no SQS queue configured', async () => {
      const store = makeStore();
      const events: unknown[] = [];
      for await (const event of store.watch()) {
        events.push(event);
        break; // Should never reach here
      }
      expect(events).toHaveLength(0);
    });
  });
});
