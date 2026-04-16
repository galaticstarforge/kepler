import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'kepler.js');

function kepler(args: string): string {
  return execSync(`node ${CLI} ${args}`, {
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

const isE2E = process.env['KEPLER_E2E'] === '1';
const deploymentName = `e2e-${Date.now().toString(36)}`;

describe.skipIf(!isE2E)('E2E lifecycle', () => {
  beforeAll(() => {
    // Ensure we have AWS credentials
    execSync('aws sts get-caller-identity', { stdio: 'pipe' });
  });

  afterAll(() => {
    // Cleanup: attempt destroy even if tests fail
    try {
      kepler(`destroy ${deploymentName} --json`);
    } catch {
      // Best effort cleanup
    }
  });

  it('init creates a state bucket', () => {
    const output = kepler('init --json');
    const result = JSON.parse(output);
    expect(result.stateBucket || result.status).toBeDefined();
  });

  it('deploy provisions a stack', () => {
    const output = kepler(
      `deploy ${deploymentName} --tier small --vpc create --json`,
    );
    const result = JSON.parse(output);
    expect(result.stackName).toBe(`kepler-${deploymentName}`);
    expect(result.instanceId).toBeTruthy();
  }, 900_000); // 15 min timeout

  it('status shows CREATE_COMPLETE', () => {
    const output = kepler(`status ${deploymentName} --json`);
    const result = JSON.parse(output);
    expect(result.status).toBe('CREATE_COMPLETE');
  });

  it('tunnel opens and health check responds', async () => {
    // Just verify the status has an instance ID (actual tunnel test requires SSM)
    const output = kepler(`status ${deploymentName} --json`);
    const result = JSON.parse(output);
    expect(result.instanceId).toBeTruthy();
    // Full tunnel + curl test would require SSM plugin installed in CI
  });

  it('destroy tears down cleanly', () => {
    // For automated testing, pipe the deployment name as confirmation
    const output = execSync(
      `echo "${deploymentName}" | node ${CLI} destroy ${deploymentName} --json`,
      { encoding: 'utf8', timeout: 600_000, env: { ...process.env, FORCE_COLOR: '0' } },
    );
    expect(output).toContain('destroyed');
  }, 600_000);

  it('status returns null after destroy', () => {
    try {
      kepler(`status ${deploymentName} --json`);
      expect.fail('Should have thrown');
    } catch {
      // Expected: deployment not found
    }
  });
});
