import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

export interface StructuralMetricsDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface StructuralMetricsConfig {
  repo: string;
  pageRank?: { maxIterations: number; dampingFactor: number };
  betweenness?: { samplingSize: number };
  leiden?: { gamma: number; theta: number; maxLevels: number };
}

export interface StructuralMetricsStats {
  projection: string;
  pageRankWritten: number;
  betweennessWritten: number;
  fanInWritten: number;
  fanOutWritten: number;
  communitiesDetected: number;
  symbolsClassified: number;
  reachableFromEntry: number;
  unreachable: number;
}

const PROJECTION_PREFIX = 'kepler-calls-';

/**
 * Runs Neo4j GDS algorithms against the `CALLS` projection and writes the
 * results back onto `Symbol` nodes and new `Community` / `MEMBER_OF`
 * structures.
 *
 * Requires the Neo4j Graph Data Science plugin. See
 * docs/graph/structural-metrics.md for details and the required GDS version.
 */
export class StructuralMetricsPass {
  private readonly log: Logger;

  constructor(private readonly deps: StructuralMetricsDeps) {
    this.log = deps.logger ?? createLogger('structural-metrics');
  }

  async run(config: StructuralMetricsConfig): Promise<StructuralMetricsStats> {
    const { repo } = config;
    const projection = `${PROJECTION_PREFIX}${repo.replaceAll(/[^a-zA-Z0-9]/g, '-')}`;
    this.log.info('structural metrics pass started', { repo, projection });

    await this.dropProjection(projection);
    await this.projectCallsGraph(projection, repo);

    try {
      const pr = config.pageRank ?? { maxIterations: 20, dampingFactor: 0.85 };
      const bt = config.betweenness ?? { samplingSize: 5000 };
      const ld = config.leiden ?? { gamma: 1, theta: 0.01, maxLevels: 10 };

      const pageRankWritten = await this.computePageRank(projection, pr);
      const betweennessWritten = await this.computeBetweenness(projection, bt);
      const { fanIn, fanOut } = await this.computeDegree(projection);
      const communitiesDetected = await this.detectCommunities(projection, ld);
      const symbolsClassified = await this.classifyCommunityRoles(repo);
      await this.materializeCommunityNodes(repo);
      const { reachable, unreachable } = await this.computeReachability(projection, repo);

      const stats: StructuralMetricsStats = {
        projection,
        pageRankWritten,
        betweennessWritten,
        fanInWritten: fanIn,
        fanOutWritten: fanOut,
        communitiesDetected,
        symbolsClassified,
        reachableFromEntry: reachable,
        unreachable,
      };
      this.log.info('structural metrics pass complete', { repo, ...stats });
      return stats;
    } finally {
      await this.dropProjection(projection);
    }
  }

  async projectCallsGraph(name: string, repo: string): Promise<void> {
    await this.deps.graph.runWrite(
      `CALL gds.graph.project.cypher(
         $name,
         'MATCH (s:Symbol {repo: $repo}) RETURN id(s) AS id',
         'MATCH (a:Symbol {repo: $repo})-[:CALLS]->(b:Symbol {repo: $repo}) RETURN id(a) AS source, id(b) AS target',
         { parameters: { repo: $repo } }
       )`,
      { name, repo },
    );
  }

  async dropProjection(name: string): Promise<void> {
    try {
      await this.deps.graph.runWrite(`CALL gds.graph.drop($name, false)`, { name });
    } catch {
      // Projection may not exist; non-fatal.
    }
  }

  async computePageRank(
    projection: string,
    params: { maxIterations: number; dampingFactor: number },
  ): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `CALL gds.pageRank.write($name, {
         writeProperty:  'pageRank',
         maxIterations:  $maxIterations,
         dampingFactor:  $dampingFactor
       })
       YIELD nodePropertiesWritten
       RETURN nodePropertiesWritten AS n`,
      { name: projection, ...params },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  async computeBetweenness(
    projection: string,
    params: { samplingSize: number },
  ): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `CALL gds.betweenness.write($name, {
         writeProperty: 'betweenness',
         samplingSize:  $samplingSize
       })
       YIELD nodePropertiesWritten
       RETURN nodePropertiesWritten AS n`,
      { name: projection, ...params },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  async computeDegree(projection: string): Promise<{ fanIn: number; fanOut: number }> {
    const fanOutRows = await this.deps.graph.runWrite(
      `CALL gds.degree.write($name, {
         writeProperty: 'fanOut',
         orientation:   'NATURAL'
       })
       YIELD nodePropertiesWritten
       RETURN nodePropertiesWritten AS n`,
      { name: projection },
      (r) => Number(r.get('n')),
    );
    const fanInRows = await this.deps.graph.runWrite(
      `CALL gds.degree.write($name, {
         writeProperty: 'fanIn',
         orientation:   'REVERSE'
       })
       YIELD nodePropertiesWritten
       RETURN nodePropertiesWritten AS n`,
      { name: projection },
      (r) => Number(r.get('n')),
    );
    return { fanIn: fanInRows[0] ?? 0, fanOut: fanOutRows[0] ?? 0 };
  }

  async detectCommunities(
    projection: string,
    params: { gamma: number; theta: number; maxLevels: number },
  ): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `CALL gds.leiden.write($name, {
         writeProperty: 'communityId',
         gamma:         $gamma,
         theta:         $theta,
         maxLevels:     $maxLevels
       })
       YIELD communityCount
       RETURN communityCount AS n`,
      { name: projection, ...params },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  async classifyCommunityRoles(repo: string): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})
       OPTIONAL MATCH (s)-[:CALLS]->(t:Symbol {repo: $repo})
       WITH s,
         sum(CASE WHEN t.communityId = s.communityId THEN 1 ELSE 0 END) AS intra,
         sum(CASE WHEN t.communityId <> s.communityId THEN 1 ELSE 0 END) AS inter
       WITH s, intra, inter, intra + inter AS total
       SET s.communityRole = CASE
         WHEN total = 0 THEN 'core'
         WHEN toFloat(inter) / total > 0.50 THEN 'bridge'
         WHEN toFloat(inter) / total > 0.15 THEN 'boundary'
         ELSE 'core'
       END
       RETURN count(s) AS n`,
      { repo },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  async materializeCommunityNodes(repo: string): Promise<void> {
    await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})
       WHERE s.communityId IS NOT NULL
       WITH s.communityId AS cid, count(s) AS sz
       MERGE (c:Community {repo: $repo, communityId: cid})
       SET c.size = sz`,
      { repo },
    );
    await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})
       WHERE s.communityId IS NOT NULL
       MATCH (c:Community {repo: $repo, communityId: s.communityId})
       MERGE (s)-[r:MEMBER_OF]->(c)
       SET r.role = coalesce(s.communityRole, 'core')`,
      { repo },
    );
    // Back-fill coreCount / boundaryCount / cohesion-hint.
    await this.deps.graph.runWrite(
      `MATCH (c:Community {repo: $repo})<-[m:MEMBER_OF]-(s:Symbol)
       WITH c,
         sum(CASE WHEN m.role = 'core'     THEN 1 ELSE 0 END) AS coreCount,
         sum(CASE WHEN m.role = 'boundary' THEN 1 ELSE 0 END) AS boundaryCount
       SET c.coreCount     = coreCount,
           c.boundaryCount = boundaryCount`,
      { repo },
    );
  }

  async computeReachability(
    projection: string,
    repo: string,
  ): Promise<{ reachable: number; unreachable: number }> {
    // Use exported symbols with no callers as entry points (the docs' heuristic).
    const entryIds = await this.deps.graph.runRead(
      `MATCH (entry:Symbol {repo: $repo})
       WHERE coalesce(entry.isExported, false) = true
         AND NOT EXISTS { MATCH (entry)<-[:CALLS]-(:Symbol) }
       RETURN collect(id(entry)) AS ids`,
      { repo },
      (r) => r.get('ids') as number[],
    );
    const ids = entryIds[0] ?? [];
    if (ids.length === 0) return { reachable: 0, unreachable: 0 };

    await this.deps.graph.runWrite(
      `CALL gds.bfs.write($name, {
         sourceNodes:   $ids,
         writeProperty: 'depthFromEntry'
       })
       YIELD nodePropertiesWritten
       RETURN nodePropertiesWritten`,
      { name: projection, ids },
    );

    const reach = await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})
       WITH s,
         CASE WHEN s.depthFromEntry IS NULL OR s.depthFromEntry < 0 THEN false ELSE true END AS reachable
       SET s.reachableFromEntry = reachable,
           s.depthFromEntry     = CASE WHEN reachable THEN s.depthFromEntry ELSE -1 END
       RETURN
         sum(CASE WHEN reachable THEN 1 ELSE 0 END) AS reachable,
         sum(CASE WHEN reachable THEN 0 ELSE 1 END) AS unreachable`,
      { repo },
      (r) => ({
        reachable: Number(r.get('reachable')),
        unreachable: Number(r.get('unreachable')),
      }),
    );
    return reach[0] ?? { reachable: 0, unreachable: 0 };
  }
}
