import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { BaseExtractorConfig } from '../config.js';
import type { GraphClient } from '../graph/graph-client.js';
import { createLogger, type Logger } from '../logger.js';

export interface FileDiscoveryDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  hash: string;
  sizeBytes: number;
}

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

const HASH_BATCH_SIZE = 500;

export class FileDiscovery {
  private readonly log: Logger;

  constructor(private readonly deps: FileDiscoveryDeps) {
    this.log = deps.logger ?? createLogger('file-discovery');
  }

  async discoverChangedFiles(
    repo: string,
    workingDir: string,
    config: BaseExtractorConfig,
  ): Promise<DiscoveredFile[]> {
    const all = await this.walkFiles(workingDir, config);
    this.log.debug('files found', { repo, count: all.length });

    const changed = await this.filterUnchanged(repo, all);
    this.log.debug('files needing index', { repo, count: changed.length });
    return changed;
  }

  private async walkFiles(workingDir: string, config: BaseExtractorConfig): Promise<DiscoveredFile[]> {
    const entries = await readdir(workingDir, { withFileTypes: true, recursive: true });
    const results: DiscoveredFile[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // Node 20.6+ uses parentPath; older Node uses path
      const parentPath = (entry as unknown as { parentPath?: string; path?: string }).parentPath
        ?? (entry as unknown as { path?: string }).path
        ?? workingDir;
      const absolutePath = path.join(parentPath, entry.name);
      const relativePath = path.relative(workingDir, absolutePath);

      // Skip if any path segment matches an ignore pattern
      const segments = relativePath.split(path.sep);
      if (segments.some((seg) => config.ignorePatterns.includes(seg))) continue;

      // Skip non-JS files
      const ext = path.extname(entry.name);
      if (!JS_EXTENSIONS.has(ext)) continue;

      // Skip oversized files
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        continue;
      }
      if (fileStat.size > config.maxFileSizeBytes) continue;

      // Compute content hash
      let content: Buffer;
      try {
        content = await readFile(absolutePath);
      } catch {
        continue;
      }
      const hash = createHash('sha256').update(content).digest('hex');

      results.push({ absolutePath, relativePath, hash, sizeBytes: fileStat.size });
    }

    return results;
  }

  private async filterUnchanged(repo: string, files: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    if (files.length === 0) return [];

    const unchangedPaths = new Set<string>();

    // Batch Neo4j hash checks to avoid large parameter payloads
    for (let i = 0; i < files.length; i += HASH_BATCH_SIZE) {
      const batch = files.slice(i, i + HASH_BATCH_SIZE);
      const params = batch.map((f) => ({ path: f.relativePath, hash: f.hash }));

      try {
        const rows = await this.deps.graph.runRead<{ path: string }>(
          `UNWIND $files AS f
           MATCH (m:Module {repo: $repo, path: f.path})
           WHERE m.hash = f.hash
           RETURN f.path AS path`,
          { repo, files: params },
          (r) => ({ path: r.get('path') as string }),
        );
        for (const row of rows) unchangedPaths.add(row.path);
      } catch (err) {
        // If the hash check fails, proceed with all files — safe to re-index
        this.log.warn('hash batch check failed, indexing all files', { repo, error: String(err) });
        return files;
      }
    }

    return files.filter((f) => !unchangedPaths.has(f.relativePath));
  }
}
