import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';
import type { Pass, PassContext, PassStats } from '../pass-runner.js';

export type ThrowConfidence = 'exact' | 'inferred' | 'heuristic';
export type ConfigAccessPattern = 'direct' | 'dynamic';
export type ConfigConfidence = 'exact' | 'heuristic';
export type CoverageKind = 'unit' | 'integration' | 'e2e';

export interface BehavioralEdgesDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface BehavioralEdgesConfig {
  repo: string;
  /** Transitive propagation depth for THROWS. Default 5. */
  throwsPropagationDepth?: number;
  /** Cap on distinct production symbols linked per test. Default 10. */
  testAssertsSymbolCap?: number;
  /**
   * Regexes tested against file paths to identify test files. If omitted,
   * uses sensible defaults (`*.test.*`, `*.spec.*`, `__tests__/**`).
   */
  testPathPatterns?: RegExp[];
}

export interface BehavioralEdgesStats {
  throwsPropagated: number;
  testAssertsEdges: number;
  testSymbolsScanned: number;
  productionSymbolsLinked: number;
}

const DEFAULT_TEST_PATTERNS: RegExp[] = [
  /\.(test|spec|e2e)\.[jt]sx?$/,
  /(^|\/)(__tests__|tests?|spec)(\/|$)/,
];

const DEFAULT_E2E_PATTERNS: RegExp[] = [/\.e2e\.[jt]sx?$/, /(^|\/)e2e(\/|$)/];
const DEFAULT_INTEGRATION_PATTERNS: RegExp[] = [
  /\.integration\.[jt]sx?$/,
  /(^|\/)integration(\/|$)/,
];

/**
 * Post-extraction pass that writes graph-wide behavioral edges not tied to
 * a single file:
 *
 *   - Transitive THROWS propagation through `CALLS` (up to a bounded depth).
 *   - `TEST_ASSERTS` edges from test symbols to production symbols they call.
 *
 * Per-file behavioral edges (direct `THROWS`, `CATCHES`, `READS_CONFIG`,
 * symbol-level `CALLS_SERVICE`) are emitted by `GraphWriter.writeBehavioral`
 * during the extraction pass and are not duplicated here.
 *
 * See docs/graph/behavioral-extraction.md#edge-types-added.
 */
export class BehavioralEdgesWriter implements Pass {
  readonly name = 'behavioral-edges';
  private readonly log: Logger;

  constructor(private readonly deps: BehavioralEdgesDeps) {
    this.log = deps.logger ?? createLogger('behavioral-edges');
  }

  async runFor(ctx: PassContext): Promise<PassStats | void> {
    const cfg = (ctx.config ?? {}) as {
      throwsPropagationDepth?: number;
      testAssertsSymbolCap?: number;
    };
    const passConfig: BehavioralEdgesConfig = {
      repo: ctx.repo,
      ...(cfg.throwsPropagationDepth === undefined
        ? {}
        : { throwsPropagationDepth: cfg.throwsPropagationDepth }),
      ...(cfg.testAssertsSymbolCap === undefined
        ? {}
        : { testAssertsSymbolCap: cfg.testAssertsSymbolCap }),
    };
    const stats = await this.run(passConfig);
    return stats as unknown as PassStats;
  }

  async run(config: BehavioralEdgesConfig): Promise<BehavioralEdgesStats> {
    const { repo } = config;
    const depth = config.throwsPropagationDepth ?? 5;
    const symbolCap = config.testAssertsSymbolCap ?? 10;
    const testPatterns = config.testPathPatterns ?? DEFAULT_TEST_PATTERNS;

    this.log.info('behavioral edges pass started', { repo, depth, symbolCap });

    const throwsPropagated = await this.propagateThrows(repo, depth);

    const { edges, symbolsScanned, productionLinked } = await this.computeTestAsserts(
      repo,
      testPatterns,
      symbolCap,
    );
    const testAssertsEdges = await this.writeTestAssertsEdges(repo, edges);

    const stats: BehavioralEdgesStats = {
      throwsPropagated,
      testAssertsEdges,
      testSymbolsScanned: symbolsScanned,
      productionSymbolsLinked: productionLinked,
    };
    this.log.info('behavioral edges pass complete', { repo, ...stats });
    return stats;
  }

  /**
   * For each symbol that calls another symbol with direct `THROWS` edges,
   * emit a propagated `THROWS` edge up to `depth` hops. Symbols that CATCH
   * the error type are assumed to swallow it and do not propagate further.
   */
  async propagateThrows(repo: string, depth: number): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `MATCH (caller:Symbol {repo: $repo})-[:CALLS*1..${depth}]->(callee:Symbol {repo: $repo})
       MATCH (callee)-[:THROWS]->(e:ErrorFlow {repo: $repo})
       WHERE NOT (caller)-[:CATCHES]->(e)
       MERGE (caller)-[r:THROWS]->(e)
       ON CREATE SET r.propagated = true, r.confidence = 'inferred'
       RETURN count(DISTINCT r) AS propagated`,
      { repo },
      (r) => Number(r.get('propagated')),
    );
    return rows[0] ?? 0;
  }

  /**
   * Identify test symbols by file path, follow their outgoing `CALLS`
   * relationships up to 2 hops, and collect up to `symbolCap` distinct
   * production symbols per test.
   */
  async computeTestAsserts(
    repo: string,
    testPatterns: RegExp[],
    symbolCap: number,
  ): Promise<{
    edges: Array<{
      testName: string;
      testFile: string;
      productionName: string;
      productionFile: string;
      coverageKind: CoverageKind;
    }>;
    symbolsScanned: number;
    productionLinked: number;
  }> {
    const testPathSources = testPatterns.map((p) => p.source);
    const rows = await this.deps.graph.runRead(
      `MATCH (test:Symbol {repo: $repo})
       WHERE any(pat IN $patterns WHERE test.filePath =~ pat)
       OPTIONAL MATCH (test)-[:CALLS*1..2]->(prod:Symbol {repo: $repo})
       WHERE NOT any(pat IN $patterns WHERE prod.filePath =~ pat)
       RETURN test.name AS testName, test.filePath AS testFile,
              prod.name AS prodName, prod.filePath AS prodFile`,
      // Cypher =~ wants `.*pattern.*`-style regex: the patterns we pass are
      // already anchored, so we wrap them in `(?i).*…` for loose match.
      { repo, patterns: testPathSources.map((s) => `(?s).*${s}.*`) },
      (r) => ({
        testName: r.get('testName') as string,
        testFile: r.get('testFile') as string,
        prodName: r.get('prodName') as string | null,
        prodFile: r.get('prodFile') as string | null,
      }),
    );

    const testsSeen = new Set<string>();
    const perTest = new Map<string, Set<string>>();
    const edges: Array<{
      testName: string;
      testFile: string;
      productionName: string;
      productionFile: string;
      coverageKind: CoverageKind;
    }> = [];

    for (const row of rows) {
      const testKey = `${row.testFile}#${row.testName}`;
      testsSeen.add(testKey);
      if (row.prodName === null || row.prodFile === null) continue;
      const bucket = perTest.get(testKey) ?? new Set<string>();
      const prodKey = `${row.prodFile}#${row.prodName}`;
      if (bucket.has(prodKey) || bucket.size >= symbolCap) {
        perTest.set(testKey, bucket);
        continue;
      }
      bucket.add(prodKey);
      perTest.set(testKey, bucket);
      edges.push({
        testName: row.testName,
        testFile: row.testFile,
        productionName: row.prodName,
        productionFile: row.prodFile,
        coverageKind: classifyCoverage(row.testFile),
      });
    }

    return {
      edges,
      symbolsScanned: testsSeen.size,
      productionLinked: edges.length,
    };
  }

  async writeTestAssertsEdges(
    repo: string,
    edges: Array<{
      testName: string;
      testFile: string;
      productionName: string;
      productionFile: string;
      coverageKind: CoverageKind;
    }>,
  ): Promise<number> {
    if (edges.length === 0) return 0;
    const rows = await this.deps.graph.runWrite(
      `UNWIND $rows AS row
       MATCH (t:Symbol {repo: $repo, filePath: row.testFile, name: row.testName})
       MATCH (p:Symbol {repo: $repo, filePath: row.productionFile, name: row.productionName})
       MERGE (t)-[r:TEST_ASSERTS]->(p)
       SET r.testFile     = row.testFile,
           r.coverageKind = row.coverageKind
       RETURN count(r) AS edges`,
      { repo, rows: edges },
      (r) => Number(r.get('edges')),
    );
    return rows[0] ?? 0;
  }
}

function classifyCoverage(filePath: string): CoverageKind {
  for (const p of DEFAULT_E2E_PATTERNS) if (p.test(filePath)) return 'e2e';
  for (const p of DEFAULT_INTEGRATION_PATTERNS) if (p.test(filePath)) return 'integration';
  return 'unit';
}
