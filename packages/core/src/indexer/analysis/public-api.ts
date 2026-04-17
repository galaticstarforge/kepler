import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

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

export interface PublicApiInput {
  isExported: boolean;
  name: string;
  docstring: string | null;
  moduleIsBarrel: boolean;
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
    const { repo } = config;
    this.log.info('public api annotation pass started', { repo });

    // Mark public API symbols in a single Cypher pass.
    const rows = await this.deps.graph.runWrite(
      `MATCH (m:Module {repo: $repo})-[:CONTAINS]->(s:Symbol)
       WITH m, s,
         coalesce(s.isExported, false) AS exported,
         coalesce(m.isBarrel, false)   AS barrel,
         s.name STARTS WITH '_'        AS underscore,
         coalesce(s.docstring, '') CONTAINS '@internal' AS internal
       SET s.isPublicApi = exported AND NOT barrel AND NOT underscore AND NOT internal
       RETURN
         count(s)                                                      AS scanned,
         sum(CASE WHEN s.isPublicApi THEN 1 ELSE 0 END)                AS markedPublic,
         sum(CASE WHEN exported AND barrel       THEN 1 ELSE 0 END)    AS excludedBarrel,
         sum(CASE WHEN exported AND internal     THEN 1 ELSE 0 END)    AS excludedInternalJsdoc,
         sum(CASE WHEN exported AND underscore   THEN 1 ELSE 0 END)    AS excludedUnderscorePrefix`,
      { repo },
      (r) => ({
        scanned: Number(r.get('scanned')),
        markedPublic: Number(r.get('markedPublic')),
        excludedBarrel: Number(r.get('excludedBarrel')),
        excludedInternalJsdoc: Number(r.get('excludedInternalJsdoc')),
        excludedUnderscorePrefix: Number(r.get('excludedUnderscorePrefix')),
      }),
    );

    const row = rows[0] ?? {
      scanned: 0,
      markedPublic: 0,
      excludedBarrel: 0,
      excludedInternalJsdoc: 0,
      excludedUnderscorePrefix: 0,
    };

    const stats: PublicApiStats = {
      symbolsScanned: row.scanned,
      markedPublic: row.markedPublic,
      excludedBarrel: row.excludedBarrel,
      excludedInternalJsdoc: row.excludedInternalJsdoc,
      excludedUnderscorePrefix: row.excludedUnderscorePrefix,
    };

    this.log.info('public api annotation pass complete', { repo, ...stats });
    return stats;
  }

  isPublicApi(symbol: PublicApiInput): boolean {
    if (!symbol.isExported) return false;
    if (symbol.moduleIsBarrel) return false;
    if (symbol.name.startsWith('_')) return false;
    if (symbol.docstring && symbol.docstring.includes('@internal')) return false;
    return true;
  }
}
