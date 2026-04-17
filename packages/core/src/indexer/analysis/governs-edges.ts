import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export interface GovernsDeclaration {
  documentPath: string;
  repo: string;
  symbolFilePath: string;
  symbolName: string;
}

export interface GovernsEdgesDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface GovernsEdgesConfig {
  /** Document paths to scan for `governs:` frontmatter declarations. */
  documentPrefix?: string;
}

export interface GovernsEdgesStats {
  documentsScanned: number;
  declarationsResolved: number;
  declarationsUnresolved: number;
  governsEdges: number;
}

/**
 * Resolves `governs:` frontmatter declarations on ADR/governance docs
 * and emits `GOVERNS` (Document → Symbol) edges. Distinct from
 * `DOCUMENTED_BY` semantically: `GOVERNS` means the document constrains
 * how the symbol can change.
 *
 * See docs/graph/semantic-enrichment.md#governs-document--symbol.
 */
export class GovernsEdgesPass {
  private readonly log: Logger;

  constructor(private readonly deps: GovernsEdgesDeps) {
    this.log = deps.logger ?? createLogger('governs-edges');
  }

  async run(config: GovernsEdgesConfig = {}): Promise<GovernsEdgesStats> {
    this.log.info('governs edges pass requested but not implemented', {
      prefix: config.documentPrefix ?? '(all)',
    });
    throw new NotImplementedError(
      'GOVERNS edge pass (document frontmatter resolution)',
      'docs/graph/semantic-enrichment.md#governs-document--symbol',
    );
  }

  async writeGovernsEdges(_edges: GovernsDeclaration[]): Promise<number> {
    throw new NotImplementedError(
      'GOVERNS edge write-back',
      'docs/graph/semantic-enrichment.md#governs-document--symbol',
    );
  }
}
