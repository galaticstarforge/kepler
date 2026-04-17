import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

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
  /**
   * Governance declarations resolved from document frontmatter. Callers
   * (the doc enrichment cron) harvest these from `governs:` frontmatter.
   */
  declarations: GovernsDeclaration[];
}

export interface GovernsEdgesStats {
  declarationsSubmitted: number;
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

  async run(config: GovernsEdgesConfig): Promise<GovernsEdgesStats> {
    const { declarations } = config;
    this.log.info('governs edges pass started', { declarations: declarations.length });
    const governsEdges = await this.writeGovernsEdges(declarations);
    const stats: GovernsEdgesStats = {
      declarationsSubmitted: declarations.length,
      governsEdges,
    };
    this.log.info('governs edges pass complete', { ...stats });
    return stats;
  }

  async writeGovernsEdges(edges: GovernsDeclaration[]): Promise<number> {
    if (edges.length === 0) return 0;
    const rows = await this.deps.graph.runWrite(
      `UNWIND $rows AS row
       MATCH (d:Document {path: row.documentPath})
       MATCH (s:Symbol {repo: row.repo, filePath: row.symbolFilePath, name: row.symbolName})
       MERGE (d)-[r:GOVERNS]->(s)
       RETURN count(r) AS n`,
      { rows: edges },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }
}
