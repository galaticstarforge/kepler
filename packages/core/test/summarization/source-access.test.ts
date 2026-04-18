import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitSourceAccess, NoopSourceAccess, MAX_FILE_READ_LINES } from '../../src/summarization/source-access.js';

let tmpDir: string;
let access: GitSourceAccess;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kepler-source-access-'));
  access = new GitSourceAccess(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function createFile(repo: string, filePath: string, content: string): Promise<void> {
  const fullPath = path.join(tmpDir, repo, filePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

describe('GitSourceAccess', () => {
  it('reads a file within a repo directory', async () => {
    await createFile('my-repo', 'src/index.ts', 'line1\nline2\nline3\n');
    const content = await access.readFile('my-repo', 'src/index.ts');
    expect(content).toContain('line1');
    expect(content).toContain('line3');
  });

  it('reads a specific line range', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await createFile('repo', 'file.ts', lines);
    const result = await access.readFile('repo', 'file.ts', { startLine: 3, endLine: 5 });
    expect(result).toBe('line3\nline4\nline5');
  });

  it('caps output at MAX_FILE_READ_LINES lines', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`).join('\n');
    await createFile('repo', 'big.ts', lines);
    const result = await access.readFile('repo', 'big.ts', { startLine: 1, endLine: 600 });
    const count = result.split('\n').length;
    expect(count).toBeLessThanOrEqual(MAX_FILE_READ_LINES);
  });

  it('lists files in a repo directory', async () => {
    await createFile('repo', 'src/a.ts', 'a');
    await createFile('repo', 'src/b.ts', 'b');
    await createFile('repo', 'lib/c.ts', 'c');
    const files = await access.listFiles('repo');
    expect(files).toHaveLength(3);
    expect(files).toContain('src/a.ts');
    expect(files).toContain('lib/c.ts');
  });

  it('excludes node_modules and dotfiles', async () => {
    await createFile('repo', 'src/a.ts', 'a');
    await createFile('repo', 'node_modules/dep/index.js', 'dep');
    await createFile('repo', '.git/HEAD', 'ref');
    const files = await access.listFiles('repo');
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('src/a.ts');
  });

  it('returns empty list for non-existent repo', async () => {
    const files = await access.listFiles('does-not-exist');
    expect(files).toEqual([]);
  });
});

describe('NoopSourceAccess', () => {
  it('returns empty string for readFile', async () => {
    const noop = new NoopSourceAccess();
    expect(await noop.readFile('repo', 'file.ts')).toBe('');
  });

  it('returns empty array for listFiles', async () => {
    const noop = new NoopSourceAccess();
    expect(await noop.listFiles('repo')).toEqual([]);
  });
});
