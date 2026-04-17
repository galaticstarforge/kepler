import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export interface GitVolatilityDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface GitVolatilityConfig {
  repo: string;
  workingDir: string;
  /** Days of history to scan for changeFrequency rolling window. */
  frequencyWindowDays?: number;
  /** Months of history to scan for authorCount. */
  authorWindowMonths?: number;
}

export interface FileVolatility {
  repo: string;
  filePath: string;
  /** Changes per 30-day rolling window over the configured frequency window. */
  changeFrequency: number;
  /** Distinct author emails over the configured author window. */
  authorCount: number;
  /** ISO-8601 timestamp of the most recent commit touching this file. */
  lastModified: string;
  /** Days since the file's first commit. */
  gitAge: number;
}

export interface GitVolatilityStats {
  filesScanned: number;
  symbolsUpdated: number;
}

/**
 * Mines `git log` to produce file-level volatility signals and writes them
 * onto the symbols contained in those files. Granularity is file-level, not
 * symbol-level — see docs/graph/semantic-enrichment.md#git-derived-volatility-signals.
 */
export class GitVolatilityPass {
  private readonly log: Logger;

  constructor(private readonly deps: GitVolatilityDeps) {
    this.log = deps.logger ?? createLogger('git-volatility');
  }

  async run(config: GitVolatilityConfig): Promise<GitVolatilityStats> {
    this.log.info('git volatility pass requested but not implemented', {
      repo: config.repo,
    });
    throw new NotImplementedError(
      'Git volatility mining pass',
      'docs/graph/semantic-enrichment.md#git-derived-volatility-signals',
    );
  }

  async collectFileVolatility(_config: GitVolatilityConfig): Promise<FileVolatility[]> {
    throw new NotImplementedError(
      'Git log volatility collection',
      'docs/graph/semantic-enrichment.md#git-derived-volatility-signals',
    );
  }

  async writeVolatilityToSymbols(_rows: FileVolatility[]): Promise<number> {
    throw new NotImplementedError(
      'Volatility write-back to Symbol nodes',
      'docs/graph/semantic-enrichment.md#git-derived-volatility-signals',
    );
  }
}
