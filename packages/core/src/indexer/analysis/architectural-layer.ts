import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';
import type { Pass, PassContext, PassStats } from '../pass-runner.js';

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
  /** Regex tested against the normalized forward-slash `Symbol.filePath`. */
  pattern: RegExp;
  layer: ArchitecturalLayerName;
  /** Higher priority wins when multiple rules match. Default: 0. */
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
  rules?: LayerRule[];
}

export interface LayerClassificationStats {
  symbolsClassified: number;
  layersCreated: number;
  inLayerEdges: number;
  unknown: number;
}

export const DEFAULT_LAYER_RULES: LayerRule[] = [
  // Tests override everything else — priority 100.
  { pattern: /(^|\/)(__tests__|__mocks__|tests?|spec)(\/|$)/, layer: 'test', priority: 100 },
  { pattern: /\.(test|spec|e2e)\.[jt]sx?$/, layer: 'test', priority: 100 },

  // Config files.
  { pattern: /(^|\/)config(\/|$)/, layer: 'config', priority: 80 },
  { pattern: /\.config\.[jt]sx?$/, layer: 'config', priority: 80 },
  { pattern: /(^|\/)settings(\/|$)/, layer: 'config', priority: 80 },

  // API boundary.
  { pattern: /(^|\/)(routes|controllers|api|handlers|endpoints|resolvers)(\/|$)/, layer: 'api', priority: 60 },

  // Services / application layer.
  { pattern: /(^|\/)services(\/|$)/, layer: 'service', priority: 50 },
  { pattern: /-service\.[jt]sx?$/, layer: 'service', priority: 50 },
  { pattern: /(^|\/)(use-?cases|interactors|workflows|commands)(\/|$)/, layer: 'service', priority: 50 },

  // Repository / persistence.
  { pattern: /(^|\/)(repositories|repos|dao|data-?access)(\/|$)/, layer: 'repository', priority: 45 },
  { pattern: /-(repository|repo|dao)\.[jt]sx?$/, layer: 'repository', priority: 45 },

  // Domain.
  { pattern: /(^|\/)(domain|entities|models|aggregates|value-?objects)(\/|$)/, layer: 'domain', priority: 40 },

  // Infrastructure / adapters.
  { pattern: /(^|\/)(infra|infrastructure|adapters|gateways|clients)(\/|$)/, layer: 'infrastructure', priority: 35 },

  // Utilities — lowest non-unknown priority.
  { pattern: /(^|\/)(utils?|helpers?|lib|common|shared)(\/|$)/, layer: 'utility', priority: 20 },
];

const ALL_LAYER_NAMES: readonly ArchitecturalLayerName[] = [
  'api',
  'service',
  'domain',
  'repository',
  'infrastructure',
  'utility',
  'test',
  'config',
  'unknown',
];

/**
 * Assigns an `architecturalLayer` property to each symbol and creates
 * `ArchitecturalLayer` nodes + `IN_LAYER` edges.
 *
 * See docs/graph/semantic-enrichment.md#architectural-layer.
 */
export class ArchitecturalLayerPass implements Pass {
  readonly name = 'architectural-layer';
  private readonly log: Logger;

  constructor(private readonly deps: LayerClassificationDeps) {
    this.log = deps.logger ?? createLogger('architectural-layer');
  }

  async runFor(ctx: PassContext): Promise<PassStats | void> {
    const cfg = (ctx.config ?? {}) as { rules?: unknown };
    const rules = Array.isArray(cfg.rules) ? parseRules(cfg.rules) : undefined;
    const passConfig: LayerClassificationConfig = {
      repo: ctx.repo,
      ...(rules === undefined ? {} : { rules }),
    };
    const stats = await this.run(passConfig);
    return stats as unknown as PassStats;
  }

  async run(config: LayerClassificationConfig): Promise<LayerClassificationStats> {
    const { repo } = config;
    const rules = [...(config.rules ?? []), ...DEFAULT_LAYER_RULES].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );

    this.log.info('architectural layer pass started', { repo, ruleCount: rules.length });

    const paths = await this.deps.graph.runRead(
      `MATCH (m:Module {repo: $repo})-[:CONTAINS]->(s:Symbol)
       RETURN s.filePath AS filePath, s.name AS name`,
      { repo },
      (r) => ({
        filePath: r.get('filePath') as string,
        name: r.get('name') as string,
      }),
    );

    const assignments = paths.map(({ filePath, name }) => ({
      filePath,
      name,
      layer: this.classifyPath(filePath, rules),
    }));

    let unknown = 0;
    for (const a of assignments) if (a.layer === 'unknown') unknown++;

    if (assignments.length > 0) {
      await this.deps.graph.runWrite(
        `UNWIND $rows AS row
         MATCH (s:Symbol {repo: $repo, filePath: row.filePath, name: row.name})
         SET s.architecturalLayer = row.layer`,
        { repo, rows: assignments },
      );
    }

    const layersCreated = await this.materializeLayerNodes(repo);
    const inLayerEdges = await this.writeInLayerEdges(repo);

    const stats: LayerClassificationStats = {
      symbolsClassified: assignments.length,
      layersCreated,
      inLayerEdges,
      unknown,
    };

    this.log.info('architectural layer pass complete', { repo, ...stats });
    return stats;
  }

  classifyPath(filePath: string, rules: LayerRule[]): ArchitecturalLayerName {
    const normalized = filePath.replaceAll('\\', '/');
    const sorted = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const rule of sorted) {
      if (rule.pattern.test(normalized)) return rule.layer;
    }
    return 'unknown';
  }

  async materializeLayerNodes(repo: string): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `UNWIND $names AS name
       MERGE (l:ArchitecturalLayer {repo: $repo, name: name})
       RETURN count(l) AS created`,
      { repo, names: ALL_LAYER_NAMES },
      (r) => Number(r.get('created')),
    );
    return rows[0] ?? 0;
  }

  async writeInLayerEdges(repo: string): Promise<number> {
    const rows = await this.deps.graph.runWrite(
      `MATCH (s:Symbol {repo: $repo})
       WHERE s.architecturalLayer IS NOT NULL
       MATCH (l:ArchitecturalLayer {repo: $repo, name: s.architecturalLayer})
       MERGE (s)-[r:IN_LAYER]->(l)
       RETURN count(r) AS edges`,
      { repo },
      (r) => Number(r.get('edges')),
    );
    return rows[0] ?? 0;
  }
}

function parseRules(raw: unknown[]): LayerRule[] {
  const parsed: LayerRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as {
      pattern?: unknown;
      layer?: unknown;
      priority?: unknown;
      source?: unknown;
    };
    if (typeof r.pattern !== 'string' || typeof r.layer !== 'string') continue;
    const layer = r.layer as ArchitecturalLayerName;
    let pattern: RegExp;
    try {
      pattern = new RegExp(r.pattern);
    } catch {
      continue;
    }
    const rule: LayerRule = { pattern, layer };
    if (typeof r.priority === 'number') rule.priority = r.priority;
    if (typeof r.source === 'string') rule.source = r.source;
    parsed.push(rule);
  }
  return parsed;
}
