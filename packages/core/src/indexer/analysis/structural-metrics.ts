import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export interface StructuralMetricsDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface StructuralMetricsConfig {
  repo: string;
  pageRank?: { maxIterations: number; dampingFactor: number };
  betweenness?: { samplingSize: number };
  leiden?: { gamma: number; theta: number; maxLevels: number };
  reachability?: { includeModuleEntryPoints: boolean };
}

export interface StructuralMetricsStats {
  pageRankWritten: number;
  betweennessWritten: number;
  fanInWritten: number;
  fanOutWritten: number;
  communitiesDetected: number;
  symbolsClassified: number;
  reachableFromEntry: number;
  unreachable: number;
}

export class StructuralMetricsPass {
  private readonly log: Logger;

  constructor(private readonly deps: StructuralMetricsDeps) {
    this.log = deps.logger ?? createLogger('structural-metrics');
  }

  async run(config: StructuralMetricsConfig): Promise<StructuralMetricsStats> {
    this.log.info('structural metrics pass requested but not implemented', {
      repo: config.repo,
    });
    throw new NotImplementedError(
      'Structural metrics pass',
      'docs/graph/structural-metrics.md',
    );
  }

  async projectCallsGraph(_name: string): Promise<void> {
    throw new NotImplementedError(
      'GDS calls-graph projection',
      'docs/graph/structural-metrics.md#projection',
    );
  }

  async dropProjection(_name: string): Promise<void> {
    throw new NotImplementedError(
      'GDS projection teardown',
      'docs/graph/structural-metrics.md#projection',
    );
  }

  async computePageRank(_projection: string): Promise<void> {
    throw new NotImplementedError(
      'GDS PageRank write-back',
      'docs/graph/structural-metrics.md#pagerank',
    );
  }

  async computeBetweenness(_projection: string): Promise<void> {
    throw new NotImplementedError(
      'GDS Betweenness (RA-Brandes) write-back',
      'docs/graph/structural-metrics.md#betweenness-centrality-approximate',
    );
  }

  async computeDegree(_projection: string): Promise<void> {
    throw new NotImplementedError(
      'GDS degree (fanIn/fanOut) write-back',
      'docs/graph/structural-metrics.md#fan-in--fan-out',
    );
  }

  async detectCommunities(_projection: string): Promise<void> {
    throw new NotImplementedError(
      'GDS Leiden community detection',
      'docs/graph/structural-metrics.md#community-detection-leiden',
    );
  }

  async classifyCommunityRoles(): Promise<void> {
    throw new NotImplementedError(
      'Community role classification (core/boundary/bridge)',
      'docs/graph/structural-metrics.md#community-role-assignment',
    );
  }

  async materializeCommunityNodes(): Promise<void> {
    throw new NotImplementedError(
      'Community node + MEMBER_OF edge materialization',
      'docs/graph/structural-metrics.md#community-node-creation',
    );
  }

  async computeReachability(_projection: string): Promise<void> {
    throw new NotImplementedError(
      'Reachability from entry points (GDS BFS)',
      'docs/graph/structural-metrics.md#reachability-from-entry-points',
    );
  }
}
