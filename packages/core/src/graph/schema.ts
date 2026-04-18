/**
 * Canonical Cypher index statements applied at startup. All are additive
 * and idempotent (`CREATE ... IF NOT EXISTS`).
 *
 * Vector indexes that depend on the configured embedding model's
 * dimension count are not listed here — see `vectorIndexStatements()`.
 */
export const CORE_INDEX_STATEMENTS: readonly string[] = [
  'CREATE INDEX module_lookup IF NOT EXISTS FOR (m:Module) ON (m.repo, m.path)',
  'CREATE INDEX symbol_lookup IF NOT EXISTS FOR (s:Symbol) ON (s.repo, s.filePath, s.name)',
  'CREATE INDEX symbol_by_name IF NOT EXISTS FOR (s:Symbol) ON (s.name)',
  'CREATE INDEX reference_location IF NOT EXISTS FOR (r:Reference) ON (r.repo, r.filePath, r.line)',
  'CREATE INDEX callsite_location IF NOT EXISTS FOR (cs:CallSite) ON (cs.repo, cs.filePath, cs.line)',
  'CREATE INDEX scope_lookup IF NOT EXISTS FOR (s:Scope) ON (s.repo, s.filePath, s.lineStart)',
  'CREATE INDEX comment_type IF NOT EXISTS FOR (c:Comment) ON (c.kind)',
  'CREATE INDEX document_path IF NOT EXISTS FOR (d:Document) ON (d.path)',
  'CREATE INDEX document_type IF NOT EXISTS FOR (d:Document) ON (d.type, d.status)',
  'CREATE INDEX document_service IF NOT EXISTS FOR (d:Document) ON (d.service)',
  'CREATE FULLTEXT INDEX symbol_name_ft IF NOT EXISTS FOR (s:Symbol) ON EACH [s.name, s.signature]',
  'CREATE FULLTEXT INDEX comment_text_ft IF NOT EXISTS FOR (c:Comment) ON EACH [c.text]',
  'CREATE FULLTEXT INDEX literal_value_ft IF NOT EXISTS FOR (l:LiteralValue) ON EACH [l.rawValue]',
  'CREATE INDEX concept_lookup IF NOT EXISTS FOR (c:Concept) ON (c.id)',
  'CREATE INDEX external_package_lookup IF NOT EXISTS FOR (p:ExternalPackage) ON (p.name)',
  'CREATE INDEX flag_name IF NOT EXISTS FOR (f:FlagDefinition) ON (f.repo, f.name)',
  'CREATE INDEX external_service_name IF NOT EXISTS FOR (e:ExternalService) ON (e.repo, e.name)',
  'CREATE INDEX community_repo IF NOT EXISTS FOR (c:Community) ON (c.repo, c.communityId)',
  'CREATE INDEX bounded_context_lookup IF NOT EXISTS FOR (bc:BoundedContext) ON (bc.repo, bc.contextId)',
  'CREATE INDEX architectural_layer_lookup IF NOT EXISTS FOR (al:ArchitecturalLayer) ON (al.repo, al.name)',
];

/** Vector index names created by `vectorIndexStatements`. */
export const VECTOR_INDEX_NAMES = {
  symbolSummary: 'symbol_summary_embedding',
  communitySummary: 'community_summary_embedding',
} as const;

export type VectorIndexName = (typeof VECTOR_INDEX_NAMES)[keyof typeof VECTOR_INDEX_NAMES];

/**
 * CREATE statements for the two vector indexes backing semantic search.
 * `dimensions` must match the embedding model configured in
 * `summarization.embedding.dimensions`.
 */
export function vectorIndexStatements(dimensions: number): string[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`vectorIndexStatements: dimensions must be a positive integer (got ${dimensions})`);
  }
  return [
    `CREATE VECTOR INDEX ${VECTOR_INDEX_NAMES.symbolSummary} IF NOT EXISTS
     FOR (ss:SymbolSummary) ON ss.embedding
     OPTIONS { indexConfig: {
       \`vector.dimensions\`: ${dimensions},
       \`vector.similarity_function\`: 'cosine'
     } }`,
    `CREATE VECTOR INDEX ${VECTOR_INDEX_NAMES.communitySummary} IF NOT EXISTS
     FOR (cs:CommunitySummary) ON cs.embedding
     OPTIONS { indexConfig: {
       \`vector.dimensions\`: ${dimensions},
       \`vector.similarity_function\`: 'cosine'
     } }`,
  ];
}

/** DROP statements for the vector indexes, used when rotating embedding models. */
export function vectorIndexDropStatements(): string[] {
  return [
    `DROP INDEX ${VECTOR_INDEX_NAMES.symbolSummary} IF EXISTS`,
    `DROP INDEX ${VECTOR_INDEX_NAMES.communitySummary} IF EXISTS`,
  ];
}

/** Minimum Neo4j version required for native vector indexes. */
export const MIN_NEO4J_VERSION_FOR_VECTOR = '5.11.0';

function toSemverParts(v: string): number[] {
  return v
    .split('-')[0]!
    .split('.')
    .map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

/**
 * Compare two dotted version strings. Returns -1 / 0 / 1. Non-numeric
 * suffixes (e.g. `-aura1`) are stripped before comparison.
 */
export function compareSemver(a: string, b: string): number {
  const av = toSemverParts(a);
  const bv = toSemverParts(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

/** True when `version` is >= the minimum required Neo4j version for vector indexes. */
export function meetsVectorIndexMinimum(version: string): boolean {
  return compareSemver(version, MIN_NEO4J_VERSION_FOR_VECTOR) >= 0;
}
