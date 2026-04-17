import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BedrockSemanticIndex } from '../src/semantic/bedrock-semantic-index.js';

const mockAgentSend = vi.fn();
const mockRuntimeSend = vi.fn();

vi.mock('../src/aws-clients.js', () => ({
  getBedrockAgentClient: () => ({ send: mockAgentSend }),
  getBedrockAgentRuntimeClient: () => ({ send: mockRuntimeSend }),
  resetClients: vi.fn(),
}));

beforeEach(() => {
  mockAgentSend.mockReset();
  mockRuntimeSend.mockReset();
});

const config = { knowledgeBaseId: 'kb-123', region: 'us-east-1', dataSourceId: 'ds-456' };

describe('BedrockSemanticIndex', () => {
  describe('search', () => {
    it('returns mapped search results', async () => {
      mockRuntimeSend.mockResolvedValueOnce({
        retrievalResults: [
          {
            score: 0.95,
            content: { text: 'This is a snippet about auth.' },
            location: { s3Location: { uri: 's3://bucket/docs/auth.md' } },
            metadata: {},
          },
          {
            score: 0.82,
            content: { text: 'Another result about payments.' },
            location: { s3Location: { uri: 's3://bucket/docs/payments.md' } },
            metadata: {},
          },
        ],
      });

      const index = new BedrockSemanticIndex(config);
      const results = await index.search('authentication');

      expect(results).toHaveLength(2);
      expect(results[0]!.path).toBe('docs/auth.md');
      expect(results[0]!.score).toBe(0.95);
      expect(results[0]!.snippet).toContain('auth');
    });

    it('filters by minScore', async () => {
      mockRuntimeSend.mockResolvedValueOnce({
        retrievalResults: [
          { score: 0.9, content: { text: 'good' }, location: { s3Location: { uri: 's3://b/a.md' } }, metadata: {} },
          { score: 0.3, content: { text: 'bad' }, location: { s3Location: { uri: 's3://b/b.md' } }, metadata: {} },
        ],
      });

      const index = new BedrockSemanticIndex(config);
      const results = await index.search('test', { minScore: 0.5 });

      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBe(0.9);
    });

    it('applies metadata filter client-side', async () => {
      mockRuntimeSend.mockResolvedValueOnce({
        retrievalResults: [
          {
            score: 0.9,
            content: { text: 'match' },
            location: { s3Location: { uri: 's3://b/a.md' } },
            metadata: { type: 'adr' },
          },
          {
            score: 0.8,
            content: { text: 'no match' },
            location: { s3Location: { uri: 's3://b/b.md' } },
            metadata: { type: 'guide' },
          },
        ],
      });

      const index = new BedrockSemanticIndex(config);
      const results = await index.search('test', { filter: { type: 'adr' } });

      expect(results).toHaveLength(1);
      expect(results[0]!.snippet).toBe('match');
    });

    it('throws SemanticIndexError on SDK failure', async () => {
      mockRuntimeSend.mockRejectedValueOnce(new Error('network error'));

      const index = new BedrockSemanticIndex(config);
      await expect(index.search('test')).rejects.toThrow('Bedrock search failed');
    });
  });

  describe('upsert', () => {
    it('triggers ingestion job when dataSourceId is configured', async () => {
      mockAgentSend.mockResolvedValueOnce({});

      const index = new BedrockSemanticIndex(config);
      await index.upsert({ path: 'test.md', content: 'test', metadata: {} });

      expect(mockAgentSend).toHaveBeenCalledOnce();
    });

    it('skips ingestion when no dataSourceId', async () => {
      const index = new BedrockSemanticIndex({ knowledgeBaseId: 'kb-123', region: 'us-east-1' });
      await index.upsert({ path: 'test.md', content: 'test', metadata: {} });

      expect(mockAgentSend).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('returns healthy when KB is ACTIVE', async () => {
      mockAgentSend.mockResolvedValueOnce({
        knowledgeBase: {
          status: 'ACTIVE',
          updatedAt: new Date('2026-01-01'),
        },
      });

      const index = new BedrockSemanticIndex(config);
      const status = await index.status();

      expect(status.healthy).toBe(true);
      expect(status.provider).toBe('bedrock');
      expect(status.lastSyncedAt).toEqual(new Date('2026-01-01'));
    });

    it('returns unhealthy when KB is not ACTIVE', async () => {
      mockAgentSend.mockResolvedValueOnce({
        knowledgeBase: { status: 'CREATING' },
      });

      const index = new BedrockSemanticIndex(config);
      const status = await index.status();
      expect(status.healthy).toBe(false);
    });

    it('throws SemanticIndexError on failure', async () => {
      mockAgentSend.mockRejectedValueOnce(new Error('access denied'));

      const index = new BedrockSemanticIndex(config);
      await expect(index.status()).rejects.toThrow('Failed to get Bedrock KB status');
    });
  });
});
