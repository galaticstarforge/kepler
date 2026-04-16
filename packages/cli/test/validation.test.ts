import { describe, it, expect } from 'vitest';

import { validateDeploymentName } from '../src/lib/validation.js';

describe('validateDeploymentName', () => {
  it('accepts valid names', () => {
    expect(() => validateDeploymentName('my-deploy')).not.toThrow();
    expect(() => validateDeploymentName('prod')).not.toThrow();
    expect(() => validateDeploymentName('a1')).not.toThrow();
    expect(() => validateDeploymentName('test-123-staging')).not.toThrow();
    expect(() => validateDeploymentName('ab')).not.toThrow();
  });

  it('rejects names that are too short', () => {
    expect(() => validateDeploymentName('a')).toThrow('2-63 characters');
  });

  it('rejects names that are too long', () => {
    const longName = 'a'.repeat(64);
    expect(() => validateDeploymentName(longName)).toThrow('2-63 characters');
  });

  it('rejects names with uppercase letters', () => {
    expect(() => validateDeploymentName('MyDeploy')).toThrow('lowercase');
  });

  it('rejects names starting with a hyphen', () => {
    expect(() => validateDeploymentName('-deploy')).toThrow('start and end');
  });

  it('rejects names ending with a hyphen', () => {
    expect(() => validateDeploymentName('deploy-')).toThrow('start and end');
  });

  it('rejects names with underscores', () => {
    expect(() => validateDeploymentName('my_deploy')).toThrow('lowercase');
  });

  it('rejects names with spaces', () => {
    expect(() => validateDeploymentName('my deploy')).toThrow('lowercase');
  });

  it('rejects names with special characters', () => {
    expect(() => validateDeploymentName('my.deploy')).toThrow('lowercase');
    expect(() => validateDeploymentName('my@deploy')).toThrow('lowercase');
  });

  it('accepts maximum length names', () => {
    const maxName = 'a' + 'b'.repeat(61) + 'c'; // 63 chars
    expect(() => validateDeploymentName(maxName)).not.toThrow();
  });
});
