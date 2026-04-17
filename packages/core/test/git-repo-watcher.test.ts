import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SourceAccessConfig } from '../src/config.js';
import { GitRepoWatcher, type RepoUpdateEvent } from '../src/repos/git-repo-watcher.js';
import type { RepoEntry, ReposConfig } from '../src/repos/repos-config.js';

let tmpRoot: string;
let upstreamDir: string;
let upstreamWorktree: string;
let cloneRoot: string;

async function makeUpstream(): Promise<{ bareUrl: string; commit: (msg: string) => Promise<string> }> {
  upstreamDir = path.join(tmpRoot, 'origin.git');
  upstreamWorktree = path.join(tmpRoot, 'origin-work');

  // Bare repo to clone from.
  await simpleGit().init(['--bare', '-b', 'main', upstreamDir]);

  // Working clone where we make commits to push to the bare.
  await simpleGit().clone(upstreamDir, upstreamWorktree);
  const work = simpleGit(upstreamWorktree);
  await work.addConfig('user.email', 'test@example.com');
  await work.addConfig('user.name', 'Test');
  await work.addConfig('commit.gpgsign', 'false');
  await work.addConfig('tag.gpgsign', 'false');
  await work.checkoutLocalBranch('main').catch(async () => {
    await work.checkout('main');
  });

  const commit = async (msg: string): Promise<string> => {
    const file = path.join(upstreamWorktree, 'README.md');
    await writeFile(file, `# ${msg}\n`, 'utf8');
    await work.add('README.md');
    await work.commit(msg);
    await work.push('origin', 'main');
    const sha = await work.revparse(['HEAD']);
    return sha.trim();
  };

  return { bareUrl: upstreamDir, commit };
}

function buildConfig(): SourceAccessConfig {
  return {
    enabled: true,
    cloneRoot,
    fetchIntervalSeconds: 3600,
  };
}

function buildRepos(url: string): { repos: ReposConfig; entry: RepoEntry } {
  const entry: RepoEntry = {
    name: 'demo',
    url,
    branch: 'main',
    cloneDepth: 0,
    ignorePatterns: [],
  };
  return {
    entry,
    repos: {
      defaults: { branch: 'main', cloneDepth: 0, ignorePatterns: [] },
      repos: [entry],
    },
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kepler-watcher-test-'));
  cloneRoot = path.join(tmpRoot, 'clones');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('GitRepoWatcher', () => {
  it('clones a repo on first sync and emits an update event', async () => {
    const { bareUrl, commit } = await makeUpstream();
    const sha = await commit('initial');

    const { repos } = buildRepos(bareUrl);
    const watcher = new GitRepoWatcher({ config: buildConfig(), repos });

    const events: RepoUpdateEvent[] = [];
    watcher.onRepoUpdated((e) => {
      events.push(e);
    });

    try {
      await watcher.start();
    } finally {
      watcher.stop();
    }

    const cloneDir = path.join(cloneRoot, 'demo');
    const headRaw = await simpleGit(cloneDir).revparse(['HEAD']);
    const head = headRaw.trim();
    expect(head).toBe(sha);
    expect(events).toHaveLength(1);
    expect(events[0].previousSha).toBeNull();
    expect(events[0].currentSha).toBe(sha);
    expect(events[0].repo.name).toBe('demo');
    expect(events[0].workingDir).toBe(cloneDir);
  });

  it('fetches and pulls new commits, emitting update events with previousSha', async () => {
    const { bareUrl, commit } = await makeUpstream();
    const firstSha = await commit('first');

    const { repos } = buildRepos(bareUrl);
    const watcher = new GitRepoWatcher({ config: buildConfig(), repos });

    const events: RepoUpdateEvent[] = [];
    watcher.onRepoUpdated((e) => {
      events.push(e);
    });

    try {
      await watcher.start();
      const secondSha = await commit('second');

      // Manually drive a sync (avoid waiting on the interval).
      await (watcher as unknown as { syncAll(): Promise<void> }).syncAll();

      const cloneDir = path.join(cloneRoot, 'demo');
      const headRaw = await simpleGit(cloneDir).revparse(['HEAD']);
      const head = headRaw.trim();
      expect(head).toBe(secondSha);
      expect(events).toHaveLength(2);
      expect(events[0].previousSha).toBeNull();
      expect(events[0].currentSha).toBe(firstSha);
      expect(events[1].previousSha).toBe(firstSha);
      expect(events[1].currentSha).toBe(secondSha);
    } finally {
      watcher.stop();
    }
  });

  it('does not emit when there are no upstream changes', async () => {
    const { bareUrl, commit } = await makeUpstream();
    await commit('only');

    const { repos } = buildRepos(bareUrl);
    const watcher = new GitRepoWatcher({ config: buildConfig(), repos });

    const events: RepoUpdateEvent[] = [];
    watcher.onRepoUpdated((e) => {
      events.push(e);
    });

    try {
      await watcher.start();
      await (watcher as unknown as { syncAll(): Promise<void> }).syncAll();
    } finally {
      watcher.stop();
    }

    expect(events).toHaveLength(1); // initial clone only
  });

  it('unsubscribe removes a listener', async () => {
    const { bareUrl, commit } = await makeUpstream();
    await commit('one');

    const { repos } = buildRepos(bareUrl);
    const watcher = new GitRepoWatcher({ config: buildConfig(), repos });

    const events: RepoUpdateEvent[] = [];
    const off = watcher.onRepoUpdated((e) => {
      events.push(e);
    });
    off();

    try {
      await watcher.start();
    } finally {
      watcher.stop();
    }

    expect(events).toHaveLength(0);
  });

  it('continues syncing other repos when one fails', async () => {
    const { bareUrl, commit } = await makeUpstream();
    await commit('healthy');

    const goodEntry: RepoEntry = {
      name: 'good',
      url: bareUrl,
      branch: 'main',
      cloneDepth: 0,
      ignorePatterns: [],
    };
    const badEntry: RepoEntry = {
      name: 'bad',
      url: path.join(tmpRoot, 'does-not-exist.git'),
      branch: 'main',
      cloneDepth: 0,
      ignorePatterns: [],
    };
    const repos: ReposConfig = {
      defaults: { branch: 'main', cloneDepth: 0, ignorePatterns: [] },
      repos: [badEntry, goodEntry],
    };

    const watcher = new GitRepoWatcher({ config: buildConfig(), repos });

    try {
      await watcher.start();
    } finally {
      watcher.stop();
    }

    const goodHeadRaw = await simpleGit(path.join(cloneRoot, 'good')).revparse(['HEAD']);
    const goodHead = goodHeadRaw.trim();
    expect(goodHead).toMatch(/^[0-9a-f]{40}$/);
  });
});
