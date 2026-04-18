import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface SourceReadOptions {
  /** 1-indexed, inclusive. Default: 1. */
  startLine?: number;
  /** 1-indexed, inclusive. Default: end of file. Capped at startLine + 499. */
  endLine?: number;
}

/** Maximum lines returnable per read_file_range call (enforced). */
export const MAX_FILE_READ_LINES = 500;

/**
 * Abstraction over bare git clone directories. The agent uses this to read
 * source files without direct filesystem access.
 */
export interface SourceAccess {
  readFile(repo: string, filePath: string, opts?: SourceReadOptions): Promise<string>;
  listFiles(repo: string): Promise<string[]>;
}

/**
 * Reads from bare git clone directories under `cloneRoot/<repo>/`.
 */
export class GitSourceAccess implements SourceAccess {
  constructor(private readonly cloneRoot: string) {}

  async readFile(repo: string, filePath: string, opts?: SourceReadOptions): Promise<string> {
    const fullPath = path.join(this.cloneRoot, repo, filePath);
    const content = await readFile(fullPath, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(0, (opts?.startLine ?? 1) - 1);
    const rawEnd = opts?.endLine === undefined ? lines.length : opts.endLine;
    const end = Math.min(lines.length, Math.min(rawEnd, start + MAX_FILE_READ_LINES));
    return lines.slice(start, end).join('\n');
  }

  async listFiles(repo: string): Promise<string[]> {
    const repoPath = path.join(this.cloneRoot, repo);
    const results: string[] = [];
    await walk(repoPath, '', results);
    return results;
  }
}

async function walk(dir: string, base: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), rel, results);
    } else {
      results.push(rel);
    }
  }
}

/** No-op implementation for testing and disabled-sourceAccess scenarios. */
export class NoopSourceAccess implements SourceAccess {
  async readFile(): Promise<string> {
    return '';
  }
  async listFiles(): Promise<string[]> {
    return [];
  }
}
