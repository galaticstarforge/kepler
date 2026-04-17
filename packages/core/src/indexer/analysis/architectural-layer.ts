import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export type ArchitecturalLayerName =
  | 'api'
  | 'service'
  | 'domain'
  | 'repository'
  | 'infrastructure'
  | 'utility'
  | 'test'
  | 'config'
  | 'unknown';

export interface LayerRule {
  /** Glob pattern matched against `Symbol.filePath`. */
  pathPattern: string;
  layer: ArchitecturalLayerName;
  /** Higher priority wins when multiple rules match. */
  priority?: number;
  /** Optional tag — plugins that contribute rules set this so we can attribute matches. */
  source?: string;
}

export interface LayerClassificationDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface LayerClassificationConfig {
  repo: string;
  /** Rules merged from defaults, repos.yaml, and plugin manifests. */
  rules: LayerRule[];
}

export interface LayerClassificationStats {
  symbolsClassified: number;
  layersCreated: number;
  inLayerEdges: number;
  unknown: number;
}

/**
 * Assigns an `architecturalLayer` property to each symbol and creates
 * `ArchitecturalLayer` nodes + `IN_LAYER` edges.
 *
 * See docs/graph/semantic-enrichment.md#architectural-layer.
 */
export class ArchitecturalLayerPass {
  private readonly log: Logger;

  constructor(private readonly deps: LayerClassificationDeps) {
    this.log = deps.logger ?? createLogger('architectural-layer');
  }

  async run(config: LayerClassificationConfig): Promise<LayerClassificationStats> {
    this.log.info('architectural layer pass requested but not implemented', {
      repo: config.repo,
      ruleCount: config.rules.length,
    });
    throw new NotImplementedError(
      'Architectural layer classification pass',
      'docs/graph/semantic-enrichment.md#architectural-layer',
    );
  }

  classify(_filePath: string, _rules: LayerRule[]): ArchitecturalLayerName {
    throw new NotImplementedError(
      'Per-file layer classification',
      'docs/graph/semantic-enrichment.md#architectural-layer',
    );
  }

  async materializeLayerNodes(_repo: string): Promise<number> {
    throw new NotImplementedError(
      'ArchitecturalLayer node materialization',
      'docs/graph/semantic-enrichment.md#architecturallayer',
    );
  }

  async writeInLayerEdges(_repo: string): Promise<number> {
    throw new NotImplementedError(
      'IN_LAYER edge creation',
      'docs/graph/semantic-enrichment.md#in_layer-symbol--architecturallayer',
    );
  }
}
