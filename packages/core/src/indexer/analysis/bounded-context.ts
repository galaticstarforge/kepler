import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';
import type { Pass, PassContext, PassStats } from '../pass-runner.js';

export interface BoundedContextDeclaration {
  contextId: string;
  name: string;
  repo: string;
  description: string;
  /** Path prefixes that belong to this context. */
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
  /**
   * Returns the bounded-context declarations for the given repo. Typically
   * sourced from `repos.yaml`. Returning an empty array is valid — the pass
   * then creates no context nodes and skips tagging.
   */
  declarationsFor?: (repo: string) => BoundedContextDeclaration[];
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
 * Parses declared bounded contexts, creates `BoundedContext` nodes, and
 * tags every symbol with the most specific matching `boundedContextId`,
 * emitting `IN_CONTEXT` edges.
 *
 * Bounded context declarations themselves are sourced from `repos.yaml`
 * by the caller and passed in via `config.declarations`.
 *
 * See docs/graph/semantic-enrichment.md#bounded-context.
 */
export class BoundedContextPass implements Pass {
  readonly name = 'bounded-context';
  private readonly log: Logger;

  constructor(private readonly deps: BoundedContextDeps) {
    this.log = deps.logger ?? createLogger('bounded-context');
  }

  async runFor(ctx: PassContext): Promise<PassStats | void> {
    const fromConfig = parseDeclarations(
      (ctx.config as { declarations?: unknown } | undefined)?.declarations,
      ctx.repo,
    );
    const fromDeps = this.deps.declarationsFor?.(ctx.repo) ?? [];
    const declarations = fromConfig.length > 0 ? fromConfig : fromDeps;
    const stats = await this.run({ repo: ctx.repo, declarations });
    return stats as unknown as PassStats;
  }

  async run(config: BoundedContextConfig): Promise<BoundedContextStats> {
    const { repo, declarations } = config;
    this.log.info('bounded context pass started', {
      repo,
      contexts: declarations.length,
    });

    const sorted = [...declarations].sort(
      (a, b) => a.declarationOrder - b.declarationOrder,
    );
    const contextsCreated = await this.materializeContextNodes(repo, sorted);

    const paths = await this.deps.graph.runRead(
      `MATCH (m:Module {repo: $repo})-[:CONTAINS]->(s:Symbol)
       RETURN s.filePath AS filePath, s.name AS name`,
      { repo },
      (r) => ({
        filePath: r.get('filePath') as string,
        name: r.get('name') as string,
      }),
    );

    let ambiguousResolved = 0;
    const assignments: Array<{ filePath: string; name: string; contextId: string }> = [];
    for (const p of paths) {
      const matches = sorted.filter((d) => this.matchesAny(p.filePath, d.patterns));
      if (matches.length === 0) continue;
      if (matches.length > 1) ambiguousResolved++;
      assignments.push({
        filePath: p.filePath,
        name: p.name,
        contextId: matches[0]!.contextId,
      });
    }

    let symbolsTagged = 0;
    if (assignments.length > 0) {
      const rows = await this.deps.graph.runWrite(
        `UNWIND $rows AS row
         MATCH (s:Symbol {repo: $repo, filePath: row.filePath, name: row.name})
         SET s.boundedContextId = row.contextId
         RETURN count(s) AS n`,
        { repo, rows: assignments },
        (r) => Number(r.get('n')),
      );
      symbolsTagged = rows[0] ?? 0;
    }

    const inContextEdges = await this.writeInContextEdges(repo);

    const stats: BoundedContextStats = {
      contextsCreated,
      symbolsTagged,
      inContextEdges,
      ambiguousResolved,
    };
    this.log.info('bounded context pass complete', { repo, ...stats });
    return stats;
  }

  resolveContext(
    filePath: string,
    declarations: BoundedContextDeclaration[],
  ): string | null {
    const sorted = [...declarations].sort(
      (a, b) => a.declarationOrder - b.declarationOrder,
    );
    for (const d of sorted) {
      if (this.matchesAny(filePath, d.patterns)) return d.contextId;
    }
    return null;
  }

  async materializeContextNodes(
    repo: string,
    declarations: BoundedContextDeclaration[],
  ): Promise<number> {
    if (declarations.length === 0) return 0;
    const rows = await this.deps.graph.runWrite(
      `UNWIND $decls AS d
       MERGE (bc:BoundedContext {repo: $repo, contextId: d.contextId})
       SET bc.name        = d.name,
           bc.description = d.description
       RETURN count(bc) AS n`,
      { repo, decls: declarations },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  async writeInContextEdges(repo: string): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})
       WHERE s.boundedContextId IS NOT NULL
       MATCH (bc:BoundedContext {repo: $repo, contextId: s.boundedContextId})
       MERGE (s)-[r:IN_CONTEXT]->(bc)
       RETURN count(r) AS n`,
      { repo },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  private matchesAny(filePath: string, patterns: string[]): boolean {
    const normalized = filePath.replaceAll('\\', '/');
    for (const pattern of patterns) {
      if (pattern.endsWith('/')) {
        if (normalized.startsWith(pattern)) return true;
      } else if (normalized === pattern || normalized.startsWith(`${pattern}/`)) {
        return true;
      }
    }
    return false;
  }
}

function parseDeclarations(raw: unknown, repo: string): BoundedContextDeclaration[] {
  if (!Array.isArray(raw)) return [];
  const out: BoundedContextDeclaration[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      contextId?: unknown;
      name?: unknown;
      description?: unknown;
      patterns?: unknown;
      declarationOrder?: unknown;
    };
    if (typeof e.contextId !== 'string' || e.contextId.length === 0) continue;
    if (!Array.isArray(e.patterns)) continue;
    const patterns = e.patterns.filter((p): p is string => typeof p === 'string');
    if (patterns.length === 0) continue;
    out.push({
      contextId: e.contextId,
      name: typeof e.name === 'string' ? e.name : e.contextId,
      repo,
      description: typeof e.description === 'string' ? e.description : '',
      patterns,
      declarationOrder:
        typeof e.declarationOrder === 'number' ? e.declarationOrder : index,
    });
  }
  return out;
}
