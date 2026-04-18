import { describe, it, expect } from 'vitest';

import {
  compareSemver,
  CORE_INDEX_STATEMENTS,
  MIN_NEO4J_VERSION_FOR_VECTOR,
  meetsVectorIndexMinimum,
  VECTOR_INDEX_NAMES,
  vectorIndexDropStatements,
  vectorIndexStatements,
} from '../src/graph/schema.js';

describe('CORE_INDEX_STATEMENTS', () => {
  it('includes the Phase D lookup indexes', () => {
    const joined = CORE_INDEX_STATEMENTS.join('\n');
    expect(joined).toContain('community_repo');
    expect(joined).toContain('bounded_context_lookup');
    expect(joined).toContain('architectural_layer_lookup');
  });
});

describe('compareSemver', () => {
  it('orders versions correctly', () => {
    expect(compareSemver('5.10.0', '5.11.0')).toBe(-1);
    expect(compareSemver('5.11.0', '5.11.0')).toBe(0);
    expect(compareSemver('5.14.3', '5.11.0')).toBe(1);
    expect(compareSemver('6.0.0', '5.99.99')).toBe(1);
  });

  it('tolerates pre-release suffixes', () => {
    expect(compareSemver('5.11.0-aura1', '5.11.0')).toBe(0);
    expect(compareSemver('5.12.0-aura1', '5.11.0')).toBe(1);
  });

  it('tolerates short versions', () => {
    expect(compareSemver('5.11', '5.11.0')).toBe(0);
    expect(compareSemver('5', '4.99.99')).toBe(1);
  });
});

describe('meetsVectorIndexMinimum', () => {
  it('rejects versions older than the documented minimum', () => {
    expect(meetsVectorIndexMinimum('5.10.0')).toBe(false);
    expect(meetsVectorIndexMinimum('4.4.18')).toBe(false);
  });

  it('accepts versions equal to or newer than the minimum', () => {
    expect(meetsVectorIndexMinimum(MIN_NEO4J_VERSION_FOR_VECTOR)).toBe(true);
    expect(meetsVectorIndexMinimum('5.14.0')).toBe(true);
    expect(meetsVectorIndexMinimum('6.0.0')).toBe(true);
  });
});

describe('vectorIndexStatements', () => {
  it('emits both indexes with the configured dimension count', () => {
    const statements = vectorIndexStatements(1536);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(VECTOR_INDEX_NAMES.symbolSummary);
    expect(statements[0]).toContain('`vector.dimensions`: 1536');
    expect(statements[0]).toContain("'cosine'");
    expect(statements[1]).toContain(VECTOR_INDEX_NAMES.communitySummary);
    expect(statements[1]).toContain('`vector.dimensions`: 1536');
  });

  it('rejects non-positive dimension counts', () => {
    expect(() => vectorIndexStatements(0)).toThrow();
    expect(() => vectorIndexStatements(-1)).toThrow();
    expect(() => vectorIndexStatements(1.5)).toThrow();
  });
});

describe('vectorIndexDropStatements', () => {
  it('emits DROP INDEX statements for both names', () => {
    const statements = vectorIndexDropStatements();
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(VECTOR_INDEX_NAMES.symbolSummary);
    expect(statements[0]).toMatch(/DROP INDEX/);
    expect(statements[1]).toContain(VECTOR_INDEX_NAMES.communitySummary);
  });
});
