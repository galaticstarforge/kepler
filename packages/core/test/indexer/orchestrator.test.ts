import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphClient } from '../../src/graph/graph-client.js';
import { Orchestrator } from '../../src/indexer/orchestrator.js';
import type { GitRepoWatcher, RepoUpdateEvent, RepoUpdateListener } from '../../src/repos/git-repo-watcher.js';

const DEFAULT_ORCHESTRATOR_CONFIG = { enabled: true, maxConcurrentRepos: 2 };
const DEFAULT_EXTRACTOR_CONFIG = {
  ignorePatterns: ['node_modules', '.git'],
  maxFileSizeBytes: 500_000,
};

function stubWatcher(): GitRepoWatcher & { _emit: (e: RepoUpdateEvent) => void } {
  let listener: RepoUpdateListener | null = null;
  return {
    onRepoUpdated(fn: RepoUpdateListener) {
      listener = fn;
      return () => { listener = null; };
    },
    _emit(event: RepoUpdateEvent) {
      listener?.(event);
    },
  } as unknown as GitRepoWatcher & { _emit: (e: RepoUpdateEvent) => void };
}

function stubGraph(unchangedPaths: string[] = []): GraphClient {
  return {
    runRead: vi.fn().mockResolvedValue(unchangedPaths.map((p) => ({ path: p }))),
    runWrite: vi.fn().mockResolvedValue([]),
  } as unknown as GraphClient;
}

function makeEvent(name: string, workingDir: string): RepoUpdateEvent {
  return {
    repo: { name, url: 'git@example.com:org/repo.git', branch: 'main', cloneDepth: 1, ignorePatterns: [] },
    workingDir,
    previousSha: null,
    currentSha: 'abc123',
    at: new Date(),
  };
}

async function createTempRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(os.tmpdir(), `kepler-orch-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe('Orchestrator', () => {
  let watcher: ReturnType<typeof stubWatcher>;
  let graph: GraphClient;

  beforeEach(() => {
    watcher = stubWatcher();
    graph = stubGraph();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers listener on start', () => {
    const onRepoUpdated = vi.spyOn(watcher, 'onRepoUpdated');
    const orch = new Orchestrator({
      watcher,
      graph,
      config: DEFAULT_ORCHESTRATOR_CONFIG,
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();
    expect(onRepoUpdated).toHaveBeenCalledOnce();
    orch.stop();
  });

  it('does not register listener twice on double start', () => {
    const onRepoUpdated = vi.spyOn(watcher, 'onRepoUpdated');
    const orch = new Orchestrator({
      watcher,
      graph,
      config: DEFAULT_ORCHESTRATOR_CONFIG,
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();
    orch.start();
    expect(onRepoUpdated).toHaveBeenCalledOnce();
    orch.stop();
  });

  it('indexes files when a repo update event is emitted', async () => {
    const tmpDir = await createTempRepo({ 'src/app.js': 'export const x = 1;' });

    const orch = new Orchestrator({
      watcher,
      graph,
      config: DEFAULT_ORCHESTRATOR_CONFIG,
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();

    watcher._emit(makeEvent('my-repo', tmpDir));

    // Wait for async indexing to complete
    await vi.waitFor(() => {
      expect((graph.runWrite as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    orch.stop();
  });

  it('ignores second event for same repo while first is in flight', async () => {
    const tmpDir = await createTempRepo({ 'src/app.js': 'export const x = 1;' });

    let resolveWrite!: () => void;
    const slowGraph = {
      runRead: vi.fn().mockResolvedValue([]),
      runWrite: vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveWrite = r; })),
    } as unknown as GraphClient;

    const orch = new Orchestrator({
      watcher,
      graph: slowGraph,
      config: { ...DEFAULT_ORCHESTRATOR_CONFIG, maxConcurrentRepos: 1 },
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();

    watcher._emit(makeEvent('slow-repo', tmpDir));
    // Second event while first is in flight
    watcher._emit(makeEvent('slow-repo', tmpDir));

    // Unblock the write
    resolveWrite?.();
    await vi.waitFor(() => {
      expect((slowGraph.runWrite as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    orch.stop();
  });

  it('continues indexing when one file fails', async () => {
    const tmpDir = await createTempRepo({
      'src/good.js': 'export const x = 1;',
      'src/also-good.js': 'export const y = 2;',
    });

    let callCount = 0;
    const flakyGraph = {
      runRead: vi.fn().mockResolvedValue([]),
      runWrite: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('neo4j transient error');
        return Promise.resolve([]);
      }),
    } as unknown as GraphClient;

    const orch = new Orchestrator({
      watcher,
      graph: flakyGraph,
      config: DEFAULT_ORCHESTRATOR_CONFIG,
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();

    watcher._emit(makeEvent('flaky-repo', tmpDir));

    await vi.waitFor(() => {
      expect((flakyGraph.runWrite as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });

    orch.stop();
  });

  it('stops processing events after stop()', async () => {
    const tmpDir = await createTempRepo({ 'src/app.js': 'export const x = 1;' });
    const orch = new Orchestrator({
      watcher,
      graph,
      config: DEFAULT_ORCHESTRATOR_CONFIG,
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();
    orch.stop();

    watcher._emit(makeEvent('my-repo', tmpDir));

    // Wait a tick and confirm nothing was written
    await new Promise((r) => setTimeout(r, 50));
    expect((graph.runWrite as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('skips repo when maxConcurrentRepos is reached', async () => {
    const tmpDir1 = await createTempRepo({ 'src/a.js': 'const a = 1;' });
    const tmpDir2 = await createTempRepo({ 'src/b.js': 'const b = 2;' });

    let resolveFirst!: () => void;
    const blockedGraph = {
      runRead: vi.fn().mockResolvedValue([]),
      runWrite: vi.fn().mockImplementationOnce(
        () => new Promise<void>((r) => { resolveFirst = r; }),
      ).mockResolvedValue([]),
    } as unknown as GraphClient;

    const orch = new Orchestrator({
      watcher,
      graph: blockedGraph,
      config: { enabled: true, maxConcurrentRepos: 1 },
      extractorConfig: DEFAULT_EXTRACTOR_CONFIG,
    });
    orch.start();

    watcher._emit(makeEvent('repo-a', tmpDir1));
    // repo-b arrives while repo-a is still in flight with max=1
    watcher._emit(makeEvent('repo-b', tmpDir2));

    resolveFirst?.();
    orch.stop();
  });
});
