import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

export interface ContentHashDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface ContentHashConfig {
  repo: string;
  workingDir: string;
}

export interface ContentHashStats {
  symbolsHashed: number;
  symbolsChanged: number;
  filesSkipped: number;
}

interface SymbolLookup {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  previousHash: string | null;
}

/**
 * Computes a per-symbol content hash over the symbol's source text slice
 * and writes it to `Symbol.hash`. Used by the summarization subsystem to
 * detect `SymbolSummary` staleness.
 *
 * The docs specify BLAKE3; we use SHA-256 from Node's stdlib to avoid a
 * native dependency. The hash is only compared for equality, so the
 * specific algorithm does not affect correctness.
 *
 * See docs/graph/semantic-enrichment.md#staleness-detection.
 */
export class SymbolContentHashPass {
  private readonly log: Logger;

  constructor(private readonly deps: ContentHashDeps) {
    this.log = deps.logger ?? createLogger('symbol-content-hash');
  }

  async run(config: ContentHashConfig): Promise<ContentHashStats> {
    const { repo, workingDir } = config;
    this.log.info('symbol content hash pass started', { repo });

    const rows = await this.deps.graph.runRead(
      `MATCH (s:Symbol {repo: $repo})
       RETURN s.filePath AS filePath, s.name AS name,
              s.lineStart AS lineStart, s.lineEnd AS lineEnd,
              s.hash AS previousHash
       ORDER BY filePath, lineStart`,
      { repo },
      (r) => ({
        name: r.get('name') as string,
        filePath: r.get('filePath') as string,
        lineStart: Number(r.get('lineStart')),
        lineEnd: Number(r.get('lineEnd')),
        previousHash: (r.get('previousHash') as string | null) ?? null,
      }) satisfies SymbolLookup,
    );

    const byFile = new Map<string, SymbolLookup[]>();
    for (const row of rows) {
      const bucket = byFile.get(row.filePath) ?? [];
      bucket.push(row);
      byFile.set(row.filePath, bucket);
    }

    let symbolsHashed = 0;
    let symbolsChanged = 0;
    let filesSkipped = 0;
    const updates: Array<{ filePath: string; name: string; hash: string }> = [];

    for (const [filePath, syms] of byFile) {
      let source: string;
      try {
        source = await readFile(join(workingDir, filePath), 'utf8');
      } catch {
        filesSkipped++;
        continue;
      }
      const lines = source.split('\n');
      for (const sym of syms) {
        const slice = lines.slice(sym.lineStart - 1, sym.lineEnd).join('\n');
        const hash = this.hashSymbolSource(slice);
        if (hash !== sym.previousHash) symbolsChanged++;
        updates.push({ filePath, name: sym.name, hash });
        symbolsHashed++;
      }
    }

    if (updates.length > 0) {
      await this.deps.graph.runWrite(
        `UNWIND $rows AS row
         MATCH (s:Symbol {repo: $repo, filePath: row.filePath, name: row.name})
         SET s.hash = row.hash`,
        { repo, rows: updates },
      );
    }

    const stats: ContentHashStats = { symbolsHashed, symbolsChanged, filesSkipped };
    this.log.info('symbol content hash pass complete', { repo, ...stats });
    return stats;
  }

  hashSymbolSource(source: string): string {
    return createHash('sha256').update(source, 'utf8').digest('hex');
  }
}
