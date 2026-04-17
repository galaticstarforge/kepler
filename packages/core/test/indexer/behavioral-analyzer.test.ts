import { describe, expect, it } from 'vitest';

import { BehavioralAnalyzer } from '../../src/indexer/extractor/behavioral-analyzer.js';
import { JsExtractor } from '../../src/indexer/extractor/js-extractor.js';

const REPO = 'test-repo';
const FILE = 'src/test.ts';
const analyzer = new BehavioralAnalyzer({ repo: REPO });
const extractor = new JsExtractor({ repo: REPO });

function analyze(code: string, file = FILE) {
  const result = extractor.extract(`/repo/${file}`, file, code);
  return analyzer.analyze(file, code, result.symbols);
}

function symbolBehavior(code: string, name: string, file = FILE) {
  const result = analyze(code, file);
  return result.symbolBehaviors.find((b) => b.name === name) ?? null;
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

describe('docstring extraction', () => {
  it('extracts JSDoc comment from function', () => {
    const code = `
/** Processes an order and returns confirmation. */
export function processOrder(id: string) {}
`;
    const b = symbolBehavior(code, 'processOrder');
    expect(b?.docstring).toBe('Processes an order and returns confirmation.');
  });

  it('strips JSDoc tags from docstring', () => {
    const code = `
/**
 * Fetches user data.
 * @param id - user id
 * @returns User object
 */
export async function fetchUser(id: string) {}
`;
    const b = symbolBehavior(code, 'fetchUser');
    expect(b?.docstring).toBe('Fetches user data.');
  });

  it('returns null when no JSDoc comment', () => {
    const code = `// regular comment\nexport function helper() {}`;
    const b = symbolBehavior(code, 'helper');
    expect(b?.docstring).toBeNull();
  });

  it('extracts JSDoc from arrow function', () => {
    const code = `
/** Validates the payload schema. */
export const validate = (payload: unknown) => true;
`;
    const b = symbolBehavior(code, 'validate');
    expect(b?.docstring).toBe('Validates the payload schema.');
  });

  it('extracts module-level docstring', () => {
    const code = `
/**
 * Payment processing utilities.
 */
export function charge() {}
`;
    const result = analyze(code);
    expect(result.moduleDocstring).toBe('Payment processing utilities.');
  });

  it('returns null module docstring when absent', () => {
    const result = analyze(`export function foo() {}`);
    expect(result.moduleDocstring).toBeNull();
  });
});

// ─── Effect classification ────────────────────────────────────────────────────

describe('effect classification', () => {
  it('detects file-read via fs.readFile', () => {
    const code = `
export async function loadConfig() {
  return fs.readFile('/etc/config.json', 'utf8');
}
`;
    const b = symbolBehavior(code, 'loadConfig');
    expect(b?.effectKinds).toContain('file-read');
    expect(b?.hasIO).toBe(true);
  });

  it('detects file-write via fs.writeFile', () => {
    const code = `
export async function saveConfig(data: string) {
  await fs.writeFile('/tmp/config.json', data);
}
`;
    const b = symbolBehavior(code, 'saveConfig');
    expect(b?.effectKinds).toContain('file-write');
    expect(b?.hasIO).toBe(true);
  });

  it('detects network-call via fetch', () => {
    const code = `
export async function getUser(id: string) {
  const res = await fetch(\`/api/users/\${id}\`);
  return res.json();
}
`;
    const b = symbolBehavior(code, 'getUser');
    expect(b?.effectKinds).toContain('network-call');
    expect(b?.hasIO).toBe(true);
  });

  it('detects network-call via axios', () => {
    const code = `
export async function postOrder(order: object) {
  return axios.post('/orders', order);
}
`;
    const b = symbolBehavior(code, 'postOrder');
    expect(b?.effectKinds).toContain('network-call');
  });

  it('detects process-spawn via exec', () => {
    const code = `
export function runScript(script: string) {
  exec(script);
}
`;
    const b = symbolBehavior(code, 'runScript');
    expect(b?.effectKinds).toContain('process-spawn');
    expect(b?.hasIO).toBe(true);
  });

  it('detects timer side effect', () => {
    const code = `
export function debounce(fn: () => void) {
  setTimeout(fn, 100);
}
`;
    const b = symbolBehavior(code, 'debounce');
    expect(b?.effectKinds).toContain('timer');
  });

  it('timer alone does not set hasIO', () => {
    const code = `
export function debounce(fn: () => void) {
  setTimeout(fn, 100);
}
`;
    const b = symbolBehavior(code, 'debounce');
    expect(b?.hasIO).toBe(false);
  });

  it('marks isPure for side-effect-free functions', () => {
    const code = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const b = symbolBehavior(code, 'add');
    expect(b?.isPure).toBe(true);
    expect(b?.hasIO).toBe(false);
    expect(b?.hasMutation).toBe(false);
  });

  it('marks isPure false when hasIO', () => {
    const code = `
export async function getData() {
  return fetch('/api/data');
}
`;
    const b = symbolBehavior(code, 'getData');
    expect(b?.isPure).toBe(false);
  });
});

// ─── Mutation detection ───────────────────────────────────────────────────────

describe('mutation detection', () => {
  it('detects this property assignment as mutation', () => {
    const code = `
export class Counter {
  count = 0;
  increment() { this.count += 1; }
}
`;
    const b = symbolBehavior(code, 'Counter');
    expect(b?.hasMutation).toBe(true);
    expect(b?.isPure).toBe(false);
  });

  it('does not flag reading this properties as mutation', () => {
    const code = `
export function getCount(obj: { count: number }) {
  return obj.count;
}
`;
    const b = symbolBehavior(code, 'getCount');
    expect(b?.hasMutation).toBe(false);
  });
});

// ─── process.env reading ──────────────────────────────────────────────────────

describe('env-read detection', () => {
  it('detects process.env.KEY access', () => {
    const code = `
export function getPort() {
  return process.env.PORT;
}
`;
    const b = symbolBehavior(code, 'getPort');
    expect(b?.effectKinds).toContain('env-read');
    expect(b?.configKeysRead).toContain('PORT');
  });

  it('detects process.env bracket access', () => {
    const code = `
export function getSecret() {
  return process.env['API_SECRET'];
}
`;
    const b = symbolBehavior(code, 'getSecret');
    expect(b?.configKeysRead).toContain('API_SECRET');
  });

  it('collects multiple env keys', () => {
    const code = `
export function buildConfig() {
  return {
    host: process.env.HOST,
    port: process.env.PORT,
    key: process.env['API_KEY'],
  };
}
`;
    const b = symbolBehavior(code, 'buildConfig');
    expect(b?.configKeysRead).toContain('HOST');
    expect(b?.configKeysRead).toContain('PORT');
    expect(b?.configKeysRead).toContain('API_KEY');
  });

  it('deduplicates repeated env keys', () => {
    const code = `
export function getPort() {
  const p = process.env.PORT;
  return Number(process.env.PORT);
}
`;
    const b = symbolBehavior(code, 'getPort');
    expect(b?.configKeysRead.filter((k) => k === 'PORT')).toHaveLength(1);
  });
});

// ─── Config.get detection ─────────────────────────────────────────────────────

describe('config.get detection', () => {
  it('detects config.get("key")', () => {
    const code = `
export function getTimeout() {
  return config.get('http.timeout');
}
`;
    const b = symbolBehavior(code, 'getTimeout');
    expect(b?.configKeysRead).toContain('http.timeout');
  });

  it('detects settings.get("key")', () => {
    const code = `
export function getDsn() {
  return settings.get('sentry.dsn');
}
`;
    const b = symbolBehavior(code, 'getDsn');
    expect(b?.configKeysRead).toContain('sentry.dsn');
  });

  it('ignores dynamic config.get with non-string arg', () => {
    const code = `
export function getValue(key: string) {
  return config.get(key);
}
`;
    const b = symbolBehavior(code, 'getValue');
    expect(b?.configKeysRead).toHaveLength(0);
  });
});

// ─── Throw detection ──────────────────────────────────────────────────────────

describe('throw detection', () => {
  it('detects throw new ErrorType()', () => {
    const code = `
export function validate(val: unknown) {
  if (!val) throw new ValidationError('Missing value');
}
`;
    const b = symbolBehavior(code, 'validate');
    expect(b?.throwTypes).toContain('ValidationError');
  });

  it('detects throw new Error()', () => {
    const code = `
export function assertExists(val: unknown) {
  if (val == null) throw new Error('Not found');
}
`;
    const b = symbolBehavior(code, 'assertExists');
    expect(b?.throwTypes).toContain('Error');
  });

  it('detects throw of an identifier', () => {
    const code = `
export function rethrow(err: Error) {
  throw err;
}
`;
    const b = symbolBehavior(code, 'rethrow');
    expect(b?.throwTypes).toContain('err');
  });

  it('deduplicates repeated throw types', () => {
    const code = `
export function check(a: unknown, b: unknown) {
  if (!a) throw new Error('a missing');
  if (!b) throw new Error('b missing');
}
`;
    const b = symbolBehavior(code, 'check');
    expect(b?.throwTypes.filter((t) => t === 'Error')).toHaveLength(1);
  });
});

// ─── Feature flag detection ───────────────────────────────────────────────────

describe('feature flag detection', () => {
  it('detects LaunchDarkly variation call', () => {
    const code = `
export async function showNewUI(ldClient: any) {
  return ldClient.variation('new-ui-enabled', false);
}
`;
    const result = analyze(code);
    const flag = result.flags.find((f) => f.name === 'new-ui-enabled');
    expect(flag).toBeDefined();
    expect(flag?.providerHint).toBe('launchdarkly');
    expect(flag?.checkKind).toBe('variant');
  });

  it('detects Unleash isEnabled call', () => {
    const code = `
export function isNewCheckout(unleash: any) {
  return unleash.isEnabled('new-checkout');
}
`;
    const result = analyze(code);
    const flag = result.flags.find((f) => f.name === 'new-checkout');
    expect(flag).toBeDefined();
    expect(flag?.providerHint).toBe('unleash');
  });

  it('detects GrowthBook isOn call', () => {
    const code = `
export function useFeature(gb: any) {
  return gb.isOn('dark-mode');
}
`;
    const result = analyze(code);
    expect(result.flags.find((f) => f.name === 'dark-mode')).toBeDefined();
  });

  it('populates featureFlagsRead on the symbol behavior', () => {
    const code = `
export function showBanner(flags: any) {
  return flags.isEnabled('promo-banner');
}
`;
    const b = symbolBehavior(code, 'showBanner');
    expect(b?.featureFlagsRead).toContain('promo-banner');
  });

  it('skips flag calls with non-literal key', () => {
    const code = `
export function check(flags: any, key: string) {
  return flags.isEnabled(key);
}
`;
    const result = analyze(code);
    expect(result.flags).toHaveLength(0);
  });
});

// ─── External service detection ───────────────────────────────────────────────

describe('external service detection', () => {
  it('detects stripe SDK import', () => {
    const code = `
import Stripe from 'stripe';
export function charge() {}
`;
    const result = analyze(code);
    const svc = result.externalServices.find((s) => s.name === 'stripe');
    expect(svc).toBeDefined();
    expect(svc?.detectionMethod).toBe('sdk-import');
    expect(svc?.protocol).toBe('http');
  });

  it('detects DynamoDB SDK import', () => {
    const code = `
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
export function getItem() {}
`;
    const result = analyze(code);
    expect(result.externalServices.find((s) => s.name === 'dynamodb')).toBeDefined();
  });

  it('detects postgres via pg', () => {
    const code = `
import { Pool } from 'pg';
export function query() {}
`;
    const result = analyze(code);
    expect(result.externalServices.find((s) => s.name === 'postgres')).toBeDefined();
  });

  it('deduplicates the same SDK imported twice', () => {
    const code = `
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
export function getItem() {}
`;
    const result = analyze(code);
    expect(result.externalServices.filter((s) => s.name === 'dynamodb')).toHaveLength(1);
  });

  it('returns empty when no known SDKs imported', () => {
    const code = `
import { readFile } from 'fs/promises';
export function load() {}
`;
    const result = analyze(code);
    expect(result.externalServices).toHaveLength(0);
  });
});

// ─── Integration: symbols without bodies ─────────────────────────────────────

describe('symbols without function bodies', () => {
  it('skips variable symbols that are not functions', () => {
    const code = `export const MAX_RETRIES = 3;`;
    const result = analyze(code);
    // MAX_RETRIES has kind 'variable', not 'function', so no behavior entry
    expect(result.symbolBehaviors.find((b) => b.name === 'MAX_RETRIES')).toBeUndefined();
  });
});
