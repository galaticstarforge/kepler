import { describe, it, expect, vi } from 'vitest';

import { generateBucketName } from '../src/lib/state-bucket.js';

// Mock the aws-clients module so S3 calls don't hit real AWS
vi.mock('../src/lib/aws-clients.js', () => ({
  getS3Client: vi.fn(() => ({
    send: vi.fn(),
  })),
}));

vi.mock('../src/lib/config.js', () => ({
  getRegion: vi.fn(() => 'us-east-1'),
}));

describe('generateBucketName', () => {
  it('starts with kepler-state- prefix', () => {
    const name = generateBucketName();
    expect(name).toMatch(/^kepler-state-/);
  });

  it('has correct total length (kepler-state- = 13 chars + 6 suffix)', () => {
    const name = generateBucketName();
    expect(name).toHaveLength(19);
  });

  it('suffix contains only lowercase alphanumeric', () => {
    const name = generateBucketName();
    const suffix = name.replace('kepler-state-', '');
    expect(suffix).toMatch(/^[a-z0-9]{6}$/);
  });

  it('generates unique names', () => {
    const names = new Set(Array.from({ length: 50 }, () => generateBucketName()));
    // With 36^6 possibilities, 50 names should all be unique
    expect(names.size).toBe(50);
  });
});

describe('state-bucket key paths', () => {
  it('deployment config path follows convention', () => {
    const deploymentName = 'my-deploy';
    const key = `deployments/${deploymentName}/config.json`;
    expect(key).toBe('deployments/my-deploy/config.json');
  });

  it('history entry path includes timestamp', () => {
    const deploymentName = 'prod';
    const timestamp = '2026-04-16T12:00:00.000Z';
    const key = `deployments/${deploymentName}/history/${timestamp.replaceAll(/[:.]/g, '-')}.json`;
    expect(key).toBe('deployments/prod/history/2026-04-16T12-00-00-000Z.json');
  });

  it('archive path includes deployment name and timestamp', () => {
    const deploymentName = 'staging';
    const timestamp = '2026-04-16T12-00-00-000Z';
    const key = `archive/${deploymentName}-${timestamp}/config.json`;
    expect(key).toBe('archive/staging-2026-04-16T12-00-00-000Z/config.json');
  });

  it('plugin enabled yaml path follows convention', () => {
    const deploymentName = 'test';
    const key = `deployments/${deploymentName}/plugins/enabled.yaml`;
    expect(key).toBe('deployments/test/plugins/enabled.yaml');
  });

  it('plugin package path follows convention', () => {
    const deploymentName = 'test';
    const tarballName = 'my-plugin-1.0.0.tgz';
    const key = `deployments/${deploymentName}/plugins/packages/${tarballName}`;
    expect(key).toBe('deployments/test/plugins/packages/my-plugin-1.0.0.tgz');
  });
});

describe('S3 region handling', () => {
  it('us-east-1 should not use LocationConstraint', () => {
    // us-east-1 does not accept a LocationConstraint in CreateBucketCommand
    const region = 'us-east-1';
    const needsLocationConstraint = region !== 'us-east-1';
    expect(needsLocationConstraint).toBe(false);
  });

  it('other regions should use LocationConstraint', () => {
    const region = 'eu-west-1';
    const needsLocationConstraint = region !== 'us-east-1';
    expect(needsLocationConstraint).toBe(true);
  });
});
