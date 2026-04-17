import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export interface PublicApiDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface PublicApiConfig {
  repo: string;
}

export interface PublicApiStats {
  symbolsScanned: number;
  markedPublic: number;
  excludedBarrel: number;
  excludedInternalJsdoc: number;
  excludedUnderscorePrefix: number;
}

/**
 * Sets `Symbol.isPublicApi` — a stricter version of `isExported` that
 * excludes barrel re-exports, `_`-prefixed symbols, and symbols tagged
 * `@internal` in JSDoc.
 *
 * See docs/graph/semantic-enrichment.md#public-surface-annotation.
 */
export class PublicApiPass {
  private readonly log: Logger;

  constructor(private readonly deps: PublicApiDeps) {
    this.log = deps.logger ?? createLogger('public-api');
  }

  async run(config: PublicApiConfig): Promise<PublicApiStats> {
    this.log.info('public api annotation pass requested but not implemented', {
      repo: config.repo,
    });
    throw new NotImplementedError(
      'Public API annotation pass',
      'docs/graph/semantic-enrichment.md#public-surface-annotation',
    );
  }

  isPublicApi(_symbol: {
    isExported: boolean;
    name: string;
    docstring: string | null;
    moduleIsBarrel: boolean;
  }): boolean {
    throw new NotImplementedError(
      'isPublicApi predicate',
      'docs/graph/semantic-enrichment.md#public-surface-annotation',
    );
  }
}
