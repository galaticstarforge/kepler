import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export interface BoundedContextDeclaration {
  contextId: string;
  name: string;
  repo: string;
  description: string;
  /** Path prefixes or explicit module patterns that belong to this context. */
  patterns: string[];
  /**
   * Declaration order is significant: overlapping paths resolve to the first
   * match. See docs/graph/semantic-enrichment.md#bounded-context.
   */
  declarationOrder: number;
}

export interface BoundedContextDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface BoundedContextConfig {
  repo: string;
  declarations: BoundedContextDeclaration[];
}

export interface BoundedContextStats {
  contextsCreated: number;
  symbolsTagged: number;
  inContextEdges: number;
  ambiguousResolved: number;
}

/**
 * Parses declared bounded contexts from `repos.yaml`, creates
 * `BoundedContext` nodes, and tags every symbol with the most specific
 * matching `boundedContextId`, emitting `IN_CONTEXT` edges.
 *
 * See docs/graph/semantic-enrichment.md#bounded-context.
 */
export class BoundedContextPass {
  private readonly log: Logger;

  constructor(private readonly deps: BoundedContextDeps) {
    this.log = deps.logger ?? createLogger('bounded-context');
  }

  async run(config: BoundedContextConfig): Promise<BoundedContextStats> {
    this.log.info('bounded context pass requested but not implemented', {
      repo: config.repo,
      contexts: config.declarations.length,
    });
    throw new NotImplementedError(
      'Bounded context tagging pass',
      'docs/graph/semantic-enrichment.md#bounded-context',
    );
  }

  resolveContext(
    _filePath: string,
    _declarations: BoundedContextDeclaration[],
  ): string | null {
    throw new NotImplementedError(
      'Bounded context resolution for a symbol',
      'docs/graph/semantic-enrichment.md#bounded-context',
    );
  }

  async materializeContextNodes(_repo: string, _decls: BoundedContextDeclaration[]): Promise<number> {
    throw new NotImplementedError(
      'BoundedContext node materialization from repos.yaml',
      'docs/graph/semantic-enrichment.md#boundedcontext',
    );
  }

  async writeInContextEdges(_repo: string): Promise<number> {
    throw new NotImplementedError(
      'IN_CONTEXT edge creation',
      'docs/graph/semantic-enrichment.md#in_context-symbol--boundedcontext',
    );
  }
}
