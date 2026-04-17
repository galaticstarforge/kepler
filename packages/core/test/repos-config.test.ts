import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReposConfigError, loadReposConfig } from '../src/repos/repos-config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-repos-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeRepos(yaml: string): Promise<string> {
  const file = path.join(tmpDir, 'repos.yaml');
  await writeFile(file, yaml, 'utf8');
  return file;
}

describe('loadReposConfig', () => {
  it('returns null when the file is missing', () => {
    const file = path.join(tmpDir, 'missing.yaml');
    expect(loadReposConfig(file)).toBeNull();
  });

  it('parses a valid config and applies defaults', async () => {
    const file = await writeRepos(`
defaults:
  branch: main
  cloneDepth: 1
  ignorePatterns:
    - node_modules/**

repos:
  - name: alpha
    url: git@github.com:org/alpha.git
  - name: beta
    url: ssh://git@gitlab.com/org/beta.git
    branch: develop
    cloneDepth: 0
`);
    const cfg = loadReposConfig(file);
    expect(cfg).not.toBeNull();
    expect(cfg!.defaults).toEqual({
      branch: 'main',
      cloneDepth: 1,
      ignorePatterns: ['node_modules/**'],
    });
    expect(cfg!.repos).toEqual([
      {
        name: 'alpha',
        url: 'git@github.com:org/alpha.git',
        branch: 'main',
        cloneDepth: 1,
        ignorePatterns: ['node_modules/**'],
      },
      {
        name: 'beta',
        url: 'ssh://git@gitlab.com/org/beta.git',
        branch: 'develop',
        cloneDepth: 0,
        ignorePatterns: ['node_modules/**'],
      },
    ]);
  });

  it('uses built-in defaults when defaults block omitted', async () => {
    const file = await writeRepos(`
repos:
  - name: only
    url: git@example.com:foo/bar.git
`);
    const cfg = loadReposConfig(file);
    expect(cfg!.defaults).toEqual({ branch: 'main', cloneDepth: 0, ignorePatterns: [] });
    expect(cfg!.repos[0].branch).toBe('main');
  });

  it('rejects HTTPS URLs', async () => {
    const file = await writeRepos(`
repos:
  - name: bad
    url: https://github.com/org/repo.git
`);
    expect(() => loadReposConfig(file)).toThrow(ReposConfigError);
  });

  it('rejects duplicate names', async () => {
    const file = await writeRepos(`
repos:
  - name: dup
    url: git@example.com:a/b.git
  - name: dup
    url: git@example.com:c/d.git
`);
    expect(() => loadReposConfig(file)).toThrow(/duplicate/);
  });

  it('rejects path-traversal names', async () => {
    const file = await writeRepos(`
repos:
  - name: ../escape
    url: git@example.com:a/b.git
`);
    expect(() => loadReposConfig(file)).toThrow(ReposConfigError);
  });

  it('rejects names containing slashes', async () => {
    const file = await writeRepos(`
repos:
  - name: foo/bar
    url: git@example.com:a/b.git
`);
    expect(() => loadReposConfig(file)).toThrow(ReposConfigError);
  });

  it('returns empty repo list for empty file', async () => {
    const file = await writeRepos('');
    const cfg = loadReposConfig(file);
    expect(cfg).not.toBeNull();
    expect(cfg!.repos).toEqual([]);
  });
});
