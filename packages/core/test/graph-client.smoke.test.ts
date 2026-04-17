import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GraphClient } from '../src/graph/graph-client.js';
import { CORE_INDEX_STATEMENTS } from '../src/graph/schema.js';

const LIVE = process.env['KEPLER_TEST_NEO4J'] === '1';
const BOLT = process.env['KEPLER_TEST_NEO4J_BOLT'] ?? 'bolt://localhost:7687';

const EXPECTED_INDEX_NAMES = [
  'module_lookup',
  'symbol_lookup',
  'symbol_by_name',
  'reference_location',
  'callsite_location',
  'scope_lookup',
  'comment_type',
  'document_path',
  'document_type',
  'document_service',
  'symbol_name_ft',
  'comment_text_ft',
  'literal_value_ft',
];

describe.skipIf(!LIVE)('GraphClient (live Neo4j — opt-in via KEPLER_TEST_NEO4J=1)', () => {
  let client: GraphClient;

  beforeAll(async () => {
    client = new GraphClient({ boltUrl: BOLT });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it('ping returns without error', async () => {
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('applySchema creates all core indexes', async () => {
    await client.applySchema(CORE_INDEX_STATEMENTS);
    const names = await client.runRead<string>(
      'SHOW INDEXES YIELD name RETURN name',
      {},
      (r) => r.get('name') as string,
    );
    for (const expected of EXPECTED_INDEX_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('applySchema is idempotent (IF NOT EXISTS)', async () => {
    await expect(client.applySchema(CORE_INDEX_STATEMENTS)).resolves.toBeUndefined();
  });
});
