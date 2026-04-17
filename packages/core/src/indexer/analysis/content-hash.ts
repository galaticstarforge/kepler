import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

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
}

/**
 * Computes a per-symbol content hash (BLAKE3 of the symbol's source text)
 * and writes it to `Symbol.hash`. Used by the summarization subsystem to
 * detect `SymbolSummary` staleness.
 *
 * See docs/graph/semantic-enrichment.md#staleness-detection.
 */
export class SymbolContentHashPass {
  private readonly log: Logger;

  constructor(private readonly deps: ContentHashDeps) {
    this.log = deps.logger ?? createLogger('symbol-content-hash');
  }

  async run(config: ContentHashConfig): Promise<ContentHashStats> {
    this.log.info('symbol content hash pass requested but not implemented', {
      repo: config.repo,
    });
    throw new NotImplementedError(
      'Per-symbol content hash pass',
      'docs/graph/semantic-enrichment.md#staleness-detection',
    );
  }

  hashSymbolSource(_source: string): string {
    throw new NotImplementedError(
      'BLAKE3 symbol source hashing',
      'docs/graph/semantic-enrichment.md#staleness-detection',
    );
  }
}
