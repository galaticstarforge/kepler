import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-summarization-config-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('summarization config', () => {
  it('defaults to Titan 1536-dim embeddings when no config file is present', () => {
    const cfg = loadConfig(path.join(tmpDir, 'missing.yaml'));
    expect(cfg.summarization.embedding.model).toBe('amazon.titan-embed-text-v2:0');
    expect(cfg.summarization.embedding.dimensions).toBe(1536);
    expect(cfg.summarization.navigationModel).toContain('haiku');
    expect(cfg.summarization.summaryModel).toContain('sonnet');
    expect(cfg.summarization.maxRunCostUSD).toBe(0);
  });

  it('merges user-provided summarization values over defaults', async () => {
    const file = path.join(tmpDir, 'config.yaml');
    await writeFile(
      file,
      [
        'summarization:',
        '  navigationModel: custom-haiku',
        '  summaryModel: custom-sonnet',
        '  embedding:',
        '    model: openai.text-embedding-3-large',
        '    dimensions: 3072',
        '  maxRunCostUSD: 12.5',
      ].join('\n'),
      'utf8',
    );

    const cfg = loadConfig(file);
    expect(cfg.summarization).toEqual({
      navigationModel: 'custom-haiku',
      summaryModel: 'custom-sonnet',
      embedding: { model: 'openai.text-embedding-3-large', dimensions: 3072 },
      maxRunCostUSD: 12.5,
      scheduleMinutes: 0,
      priorityWeights: { pageRank: 0.4, fanIn: 0.3, publicApi: 0.2, changeFrequency: 0.1, canonicalPenalty: 1 },
    });
  });

  it('partially overrides embedding nested defaults', async () => {
    const file = path.join(tmpDir, 'config.yaml');
    await writeFile(
      file,
      [
        'summarization:',
        '  embedding:',
        '    dimensions: 768',
      ].join('\n'),
      'utf8',
    );
    const cfg = loadConfig(file);
    expect(cfg.summarization.embedding.dimensions).toBe(768);
    expect(cfg.summarization.embedding.model).toBe('amazon.titan-embed-text-v2:0');
  });
});
