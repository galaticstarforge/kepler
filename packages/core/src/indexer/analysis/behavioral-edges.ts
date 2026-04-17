import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

import { NotImplementedError } from './errors.js';

export type ThrowConfidence = 'exact' | 'inferred' | 'heuristic';
export type ConfigAccessPattern = 'direct' | 'dynamic';
export type ConfigConfidence = 'exact' | 'heuristic';
export type CoverageKind = 'unit' | 'integration' | 'e2e';

export interface ThrowsEdge {
  repo: string;
  sourceSymbolFqn: string;
  errorType: string;
  propagated: boolean;
  confidence: ThrowConfidence;
}

export interface CatchesEdge {
  repo: string;
  sourceSymbolFqn: string;
  errorType: string;
  /** Raw catch clause text, truncated to 200 chars. */
  catchBlock: string;
}

export interface ReadsConfigEdge {
  repo: string;
  sourceSymbolFqn: string;
  configKey: string;
  accessPattern: ConfigAccessPattern;
  confidence: ConfigConfidence;
}

export interface CallsServiceEdge {
  repo: string;
  sourceSymbolFqn: string;
  serviceName: string;
  protocol: 'http' | 'grpc' | 'amqp' | 'graphql';
  confidence: 'exact' | 'heuristic';
}

export interface TestAssertsEdge {
  repo: string;
  testSymbolFqn: string;
  productionSymbolFqn: string;
  /** At most 3 assertion strings, each truncated to 200 chars. */
  assertionExamples: string[];
  testFile: string;
  coverageKind: CoverageKind;
}

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
  /** Path patterns that identify test files. */
  testPathPatterns?: string[];
}

export interface BehavioralEdgesStats {
  throwsEdges: number;
  catchesEdges: number;
  readsConfigEdges: number;
  callsServiceEdges: number;
  testAssertsEdges: number;
  errorFlowNodes: number;
  configItemNodes: number;
}

/**
 * Persists documented-but-unimplemented behavioral edges:
 *
 *   - `THROWS` (Symbol → ErrorFlow), with transitive propagation
 *   - `CATCHES` (Symbol → ErrorFlow)
 *   - `READS_CONFIG` (Symbol → ConfigItem)
 *   - `CALLS_SERVICE` (Symbol → ExternalService) at the symbol level
 *   - `TEST_ASSERTS` (TestSymbol → Symbol)
 *
 * See docs/graph/behavioral-extraction.md#edge-types-added.
 */
export class BehavioralEdgesWriter {
  private readonly log: Logger;

  constructor(private readonly deps: BehavioralEdgesDeps) {
    this.log = deps.logger ?? createLogger('behavioral-edges');
  }

  async run(config: BehavioralEdgesConfig): Promise<BehavioralEdgesStats> {
    this.log.info('behavioral edges writer requested but not implemented', {
      repo: config.repo,
    });
    throw new NotImplementedError(
      'Behavioral edges writer',
      'docs/graph/behavioral-extraction.md#edge-types-added',
    );
  }

  async writeThrowsEdges(_edges: ThrowsEdge[]): Promise<void> {
    throw new NotImplementedError(
      'THROWS edges + ErrorFlow nodes',
      'docs/graph/behavioral-extraction.md#throws-symbol--errorflow',
    );
  }

  async propagateThrows(_repo: string, _depth: number): Promise<number> {
    throw new NotImplementedError(
      'Transitive THROWS propagation through CALLS',
      'docs/graph/behavioral-extraction.md#throws-symbol--errorflow',
    );
  }

  async writeCatchesEdges(_edges: CatchesEdge[]): Promise<void> {
    throw new NotImplementedError(
      'CATCHES edges (catch-clause detection + persistence)',
      'docs/graph/behavioral-extraction.md#catches-symbol--errorflow',
    );
  }

  async writeReadsConfigEdges(_edges: ReadsConfigEdge[]): Promise<void> {
    throw new NotImplementedError(
      'READS_CONFIG edges to ConfigItem nodes',
      'docs/graph/behavioral-extraction.md#reads_config-symbol--configitem',
    );
  }

  async writeCallsServiceEdges(_edges: CallsServiceEdge[]): Promise<void> {
    throw new NotImplementedError(
      'Symbol-level CALLS_SERVICE edges (currently module-level IMPORTS_SERVICE only)',
      'docs/graph/behavioral-extraction.md#calls_service-symbol--externalservice',
    );
  }

  async writeTestAssertsEdges(_edges: TestAssertsEdge[]): Promise<void> {
    throw new NotImplementedError(
      'TEST_ASSERTS edges + assertion text extraction',
      'docs/graph/behavioral-extraction.md#test_asserts-testsymbol--symbol',
    );
  }
}
