import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphClient } from '../../src/graph/graph-client.js';
import { FileDiscovery } from '../../src/indexer/file-discovery.js';

const DEFAULT_CONFIG = {
  ignorePatterns: ['node_modules', '.git', 'dist'],
  maxFileSizeBytes: 100_000,
};

function stubGraph(unchangedPaths: string[] = []): GraphClient {
  return {
    runRead: vi.fn().mockResolvedValue(unchangedPaths.map((p) => ({ path: p }))),
  } as unknown as GraphClient;
}

async function createTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `kepler-test-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function touch(dir: string, relPath: string, content = 'const x = 1;'): Promise<string> {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

describe('FileDiscovery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns JS files from the repo root', async () => {
    await touch(tmpDir, 'src/app.js');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.some((f) => f.relativePath === 'src/app.js')).toBe(true);
  });

  it('skips node_modules directory', async () => {
    await touch(tmpDir, 'node_modules/lodash/index.js');
    await touch(tmpDir, 'src/app.js');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.every((f) => !f.relativePath.includes('node_modules'))).toBe(true);
  });

  it('skips non-JS files', async () => {
    await touch(tmpDir, 'README.md', '# hello');
    await touch(tmpDir, 'config.json', '{}');
    await touch(tmpDir, 'styles.css', '.foo {}');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files).toHaveLength(0);
  });

  it('includes jsx files', async () => {
    await touch(tmpDir, 'src/Button.jsx', 'export function Button() {}');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.some((f) => f.relativePath === 'src/Button.jsx')).toBe(true);
  });

  it('includes mjs and cjs files', async () => {
    await touch(tmpDir, 'lib/util.mjs');
    await touch(tmpDir, 'lib/compat.cjs');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain('lib/util.mjs');
    expect(names).toContain('lib/compat.cjs');
  });

  it('skips files exceeding maxFileSizeBytes', async () => {
    const bigContent = 'x'.repeat(200);
    await touch(tmpDir, 'src/big.js', bigContent);
    const config = { ...DEFAULT_CONFIG, maxFileSizeBytes: 100 };
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, config);
    expect(files.every((f) => f.relativePath !== 'src/big.js')).toBe(true);
  });

  it('excludes files whose hash is already in Neo4j', async () => {
    await touch(tmpDir, 'src/app.js', 'const x = 1;');
    // Discovery will compute a real hash; we need to match it
    const discoveryForHash = new FileDiscovery({ graph: stubGraph([]) });
    const allFiles = await discoveryForHash.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    const knownPath = allFiles[0]?.relativePath ?? '';

    // Now stub graph to return that path (meaning: hash matches, skip it)
    const discovery = new FileDiscovery({ graph: stubGraph([knownPath]) });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.every((f) => f.relativePath !== knownPath)).toBe(true);
  });

  it('includes new file not present in Neo4j', async () => {
    await touch(tmpDir, 'src/new.js');
    // Graph returns no known paths — file is new
    const discovery = new FileDiscovery({ graph: stubGraph([]) });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.some((f) => f.relativePath === 'src/new.js')).toBe(true);
  });

  it('returns correct relativePath for deeply nested files', async () => {
    await touch(tmpDir, 'src/features/payments/processor.js');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.some((f) => f.relativePath === 'src/features/payments/processor.js')).toBe(true);
  });

  it('computes a non-empty hash', async () => {
    await touch(tmpDir, 'src/app.js', 'export const x = 1;');
    const discovery = new FileDiscovery({ graph: stubGraph() });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to returning all files when hash check throws', async () => {
    await touch(tmpDir, 'src/app.js');
    const brokenGraph = {
      runRead: vi.fn().mockRejectedValue(new Error('neo4j down')),
    } as unknown as GraphClient;
    const discovery = new FileDiscovery({ graph: brokenGraph });
    const files = await discovery.discoverChangedFiles('repo', tmpDir, DEFAULT_CONFIG);
    expect(files.some((f) => f.relativePath === 'src/app.js')).toBe(true);
  });
});
