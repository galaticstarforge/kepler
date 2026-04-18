import { readFile, writeFile, unlink, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  DocumentBytes,
  DocumentHead,
  DocumentMetadata,
  DocumentStore,
  DocumentStoreEvent,
} from '@keplerforge/shared';
import { watch as chokidarWatch } from 'chokidar';


import { createLogger } from '../logger.js';

const log = createLogger('filesystem-document-store');

interface SidecarMeta {
  contentType: string;
  etag?: string;
  custom: Record<string, string>;
}

function sidecarPath(filePath: string): string {
  return filePath + '.meta.json';
}

async function readSidecar(filePath: string): Promise<SidecarMeta | null> {
  try {
    const raw = await readFile(sidecarPath(filePath), 'utf8');
    return JSON.parse(raw) as SidecarMeta;
  } catch {
    return null;
  }
}

async function writeSidecar(filePath: string, meta: SidecarMeta): Promise<void> {
  await writeFile(sidecarPath(filePath), JSON.stringify(meta, null, 2), 'utf8');
}

async function removeSidecar(filePath: string): Promise<void> {
  try {
    await unlink(sidecarPath(filePath));
  } catch {
    // Ignore if sidecar doesn't exist.
  }
}

export class FilesystemDocumentStore implements DocumentStore {
  constructor(private readonly rootDir: string) {}

  private resolve(docPath: string): string {
    return path.join(this.rootDir, docPath);
  }

  async get(docPath: string): Promise<DocumentBytes | null> {
    const fullPath = this.resolve(docPath);
    try {
      const [content, stats, sidecar] = await Promise.all([
        readFile(fullPath),
        stat(fullPath),
        readSidecar(fullPath),
      ]);

      const metadata: DocumentMetadata = {
        contentType: sidecar?.contentType ?? 'text/markdown',
        contentLength: stats.size,
        lastModified: stats.mtime,
        etag: sidecar?.etag,
        custom: sidecar?.custom ?? {},
      };

      return { content, metadata, lastModified: stats.mtime, etag: sidecar?.etag };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async put(docPath: string, content: Buffer, metadata: DocumentMetadata): Promise<void> {
    const fullPath = this.resolve(docPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    await writeSidecar(fullPath, {
      contentType: metadata.contentType,
      etag: metadata.etag,
      custom: metadata.custom,
    });
  }

  async delete(docPath: string): Promise<void> {
    const fullPath = this.resolve(docPath);
    try {
      await unlink(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await removeSidecar(fullPath);
  }

  async *list(prefix: string): AsyncIterable<DocumentHead> {
    const dir = this.resolve(prefix);
    yield* this.walkDir(dir, prefix);
  }

  private async *walkDir(dir: string, basePrefix: string): AsyncIterable<DocumentHead> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.name.endsWith('.meta.json')) continue;

      if (entry.isDirectory()) {
        yield* this.walkDir(fullPath, path.posix.join(basePrefix, entry.name));
      } else if (entry.isFile()) {
        const docPath = path.posix.join(basePrefix, entry.name);
        const head = await this.head(docPath);
        if (head) yield head;
      }
    }
  }

  async head(docPath: string): Promise<DocumentHead | null> {
    const fullPath = this.resolve(docPath);
    try {
      const [stats, sidecar] = await Promise.all([stat(fullPath), readSidecar(fullPath)]);
      return {
        path: docPath,
        metadata: {
          contentType: sidecar?.contentType ?? 'text/markdown',
          contentLength: stats.size,
          lastModified: stats.mtime,
          etag: sidecar?.etag,
          custom: sidecar?.custom ?? {},
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async *watch(): AsyncIterable<DocumentStoreEvent> {
    const watcher = chokidarWatch(this.rootDir, {
      ignoreInitial: true,
      ignored: /\.meta\.json$/,
    });

    const events: DocumentStoreEvent[] = [];
    let resolve: (() => void) | null = null;

    const push = (event: DocumentStoreEvent) => {
      events.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    watcher.on('add', (filePath) => {
      const docPath = path.relative(this.rootDir, filePath).split(path.sep).join('/');
      push({ type: 'created', path: docPath, timestamp: new Date() });
    });
    watcher.on('change', (filePath) => {
      const docPath = path.relative(this.rootDir, filePath).split(path.sep).join('/');
      push({ type: 'updated', path: docPath, timestamp: new Date() });
    });
    watcher.on('unlink', (filePath) => {
      const docPath = path.relative(this.rootDir, filePath).split(path.sep).join('/');
      push({ type: 'deleted', path: docPath, timestamp: new Date() });
    });

    watcher.on('error', (err) => {
      log.error('watcher error', { error: String(err) });
    });

    try {
      while (true) {
        if (events.length === 0) {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
        while (events.length > 0) {
          yield events.shift()!;
        }
      }
    } finally {
      await watcher.close();
    }
  }
}
