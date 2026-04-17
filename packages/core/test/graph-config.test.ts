import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-graph-config-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('storage.graph config', () => {
  it('defaults to bolt://localhost:7687 when no config file is present', () => {
    const cfg = loadConfig(path.join(tmpDir, 'missing.yaml'));
    expect(cfg.storage.graph.bolt).toBe('bolt://localhost:7687');
    expect(cfg.storage.graph.username).toBeUndefined();
    expect(cfg.storage.graph.password).toBeUndefined();
  });

  it('merges user-provided storage.graph values over defaults', async () => {
    const file = path.join(tmpDir, 'config.yaml');
    await writeFile(
      file,
      [
        'storage:',
        '  graph:',
        '    bolt: bolt://neo4j:7687',
        '    username: neo4j',
        '    password: secret',
        '    database: keplerdb',
        '    maxPoolSize: 25',
      ].join('\n'),
      'utf8',
    );

    const cfg = loadConfig(file);
    expect(cfg.storage.graph).toEqual({
      bolt: 'bolt://neo4j:7687',
      username: 'neo4j',
      password: 'secret',
      database: 'keplerdb',
      maxPoolSize: 25,
    });
  });

  it('preserves unrelated storage sections when graph is overridden', async () => {
    const file = path.join(tmpDir, 'config.yaml');
    await writeFile(
      file,
      [
        'storage:',
        '  graph:',
        '    bolt: bolt://elsewhere:7687',
      ].join('\n'),
      'utf8',
    );
    const cfg = loadConfig(file);
    expect(cfg.storage.graph.bolt).toBe('bolt://elsewhere:7687');
    expect(cfg.storage.documents.provider).toBe('filesystem');
    expect(cfg.storage.semanticIndex.provider).toBe('none');
  });
});
