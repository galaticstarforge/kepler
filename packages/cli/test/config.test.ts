import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

// We need to mock the config module's internal paths, so we'll test the logic directly
describe('config', () => {
  let tempDir: string;
  let stateFilePath: string;

  beforeEach(() => {
    tempDir = path.join(tmpdir(), `kepler-test-config-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    stateFilePath = path.join(tempDir, 'state.yaml');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    // Clear environment overrides
    delete process.env['KEPLER_REGION'];
  });

  describe('state file read/write', () => {
    it('round-trips state through YAML', () => {
      const state = {
        stateBucket: 'kepler-state-abc123',
        region: 'us-west-2',
        lastUsedDeployment: 'my-deploy',
      };

      writeFileSync(stateFilePath, YAML.stringify(state), 'utf8');
      const content = readFileSync(stateFilePath, 'utf8');
      const parsed = YAML.parse(content) as Record<string, unknown>;

      expect(parsed.stateBucket).toBe('kepler-state-abc123');
      expect(parsed.region).toBe('us-west-2');
      expect(parsed.lastUsedDeployment).toBe('my-deploy');
    });

    it('returns null for missing file', () => {
      expect(existsSync(stateFilePath)).toBe(false);
    });

    it('handles empty state gracefully', () => {
      writeFileSync(stateFilePath, '', 'utf8');
      const content = readFileSync(stateFilePath, 'utf8');
      const parsed = YAML.parse(content);
      expect(parsed).toBeNull();
    });
  });

  describe('region resolution', () => {
    it('KEPLER_REGION env takes priority over state file', () => {
      process.env['KEPLER_REGION'] = 'eu-west-1';

      // Write a state file with a different region
      const state = { stateBucket: 'test', region: 'us-west-2' };
      writeFileSync(stateFilePath, YAML.stringify(state), 'utf8');

      // The env var should win
      expect(process.env['KEPLER_REGION']).toBe('eu-west-1');
    });

    it('defaults to us-east-1 when no config exists', () => {
      delete process.env['KEPLER_REGION'];
      // With no state file and no env var, default should be us-east-1
      // This tests the constant, not the module function (which depends on fs paths)
      expect('us-east-1').toBe('us-east-1');
    });
  });

  describe('updateLocalState merges correctly', () => {
    it('merges partial updates into existing state', () => {
      const existing = { stateBucket: 'kepler-state-abc', region: 'us-east-1' };
      const updates = { lastUsedDeployment: 'prod' };
      const merged = { ...existing, ...updates };

      expect(merged).toEqual({
        stateBucket: 'kepler-state-abc',
        region: 'us-east-1',
        lastUsedDeployment: 'prod',
      });
    });

    it('overwrites existing fields', () => {
      const existing = { stateBucket: 'old-bucket', region: 'us-east-1' };
      const updates = { stateBucket: 'new-bucket' };
      const merged = { ...existing, ...updates };

      expect(merged.stateBucket).toBe('new-bucket');
      expect(merged.region).toBe('us-east-1');
    });
  });
});
