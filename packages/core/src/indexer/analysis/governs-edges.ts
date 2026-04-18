import type { DocumentStore } from '@kepler/shared';

import { parseFrontmatter } from '../../docs/frontmatter-parser.js';
import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';
import type { Pass, PassContext, PassStats } from '../pass-runner.js';

export interface GovernsDeclaration {
  documentPath: string;
  repo: string;
  symbolFilePath: string;
  symbolName: string;
}

export interface GovernsEdgesDeps {
  graph: GraphClient;
  logger?: Logger;
  /**
   * Doc store used to resolve `governs:` / `symbols:` frontmatter. When
   * omitted, `runFor` falls back to declarations passed via pass config.
   */
  store?: DocumentStore;
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
  documentsScanned: number;
}

/**
 * Resolves `governs:` frontmatter declarations on ADR/governance docs
 * and emits `GOVERNS` (Document → Symbol) edges. Distinct from
 * `DOCUMENTED_BY` semantically: `GOVERNS` means the document constrains
 * how the symbol can change.
 *
 * See docs/graph/semantic-enrichment.md#governs-document--symbol.
 */
export class GovernsEdgesPass implements Pass {
  readonly name = 'governs-edges';
  private readonly log: Logger;

  constructor(private readonly deps: GovernsEdgesDeps) {
    this.log = deps.logger ?? createLogger('governs-edges');
  }

  async runFor(ctx: PassContext): Promise<PassStats | void> {
    const cfg = (ctx.config ?? {}) as {
      declarations?: unknown;
      pathPrefix?: unknown;
    };
    const fromConfig = parseDeclarations(cfg.declarations);
    let declarations: GovernsDeclaration[] = fromConfig;
    let documentsScanned = 0;
    if (declarations.length === 0 && this.deps.store) {
      const prefix = typeof cfg.pathPrefix === 'string' ? cfg.pathPrefix : '';
      const harvest = await harvestFromStore(this.deps.store, ctx.repo, prefix);
      declarations = harvest.declarations;
      documentsScanned = harvest.documentsScanned;
    }
    const stats = await this.run({ declarations });
    return { ...stats, documentsScanned } as unknown as PassStats;
  }

  async run(config: GovernsEdgesConfig): Promise<GovernsEdgesStats> {
    const { declarations } = config;
    this.log.info('governs edges pass started', { declarations: declarations.length });
    const governsEdges = await this.writeGovernsEdges(declarations);
    const stats: GovernsEdgesStats = {
      declarationsSubmitted: declarations.length,
      governsEdges,
      documentsScanned: 0,
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

function parseDeclarations(raw: unknown): GovernsDeclaration[] {
  if (!Array.isArray(raw)) return [];
  const out: GovernsDeclaration[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      documentPath?: unknown;
      repo?: unknown;
      symbolFilePath?: unknown;
      symbolName?: unknown;
    };
    if (
      typeof e.documentPath === 'string' &&
      typeof e.repo === 'string' &&
      typeof e.symbolFilePath === 'string' &&
      typeof e.symbolName === 'string'
    ) {
      out.push({
        documentPath: e.documentPath,
        repo: e.repo,
        symbolFilePath: e.symbolFilePath,
        symbolName: e.symbolName,
      });
    }
  }
  return out;
}

interface SymbolRef {
  repo?: string;
  path?: string;
  name?: string;
}

async function harvestFromStore(
  store: DocumentStore,
  repo: string,
  prefix: string,
): Promise<{ declarations: GovernsDeclaration[]; documentsScanned: number }> {
  const declarations: GovernsDeclaration[] = [];
  let documentsScanned = 0;
  for await (const head of store.list(prefix)) {
    if (!head.path.endsWith('.md')) continue;
    documentsScanned++;
    const bytes = await store.get(head.path);
    if (!bytes) continue;
    const parsed = parseFrontmatter(bytes.content);
    if (!parsed.data) continue;
    const data = parsed.data as {
      governs?: unknown;
      symbols?: unknown;
    };
    const refs = [...collectSymbolRefs(data.governs), ...collectSymbolRefs(data.symbols)];
    for (const ref of refs) {
      if (
        typeof ref.path === 'string' &&
        typeof ref.name === 'string' &&
        (ref.repo === undefined || ref.repo === repo)
      ) {
        declarations.push({
          documentPath: head.path,
          repo: ref.repo ?? repo,
          symbolFilePath: ref.path,
          symbolName: ref.name,
        });
      }
    }
  }
  return { declarations, documentsScanned };
}

function collectSymbolRefs(raw: unknown): SymbolRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SymbolRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    out.push(entry as SymbolRef);
  }
  return out;
}
