import { describe, it, expect } from 'vitest';

import { createApp } from '../src/app.js';
import { getStackName } from '../src/deployer.js';
import type { DeploymentConfig } from '../src/types.js';

const TEST_CONFIG: DeploymentConfig = {
  deploymentName: 'test-deploy',
  region: 'us-east-1',
  stateBucketName: 'kepler-state-abc123',
  instanceTier: 'small',
  vpcStrategy: 'create',
  keplerVersion: '0.0.1',
};

describe('getStackName', () => {
  it('prefixes deployment name with kepler-', () => {
    expect(getStackName('my-deploy')).toBe('kepler-my-deploy');
  });
});

describe('createApp', () => {
  it('synthesizes a valid cloud assembly', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();

    expect(assembly.directory).toBeTruthy();
    expect(assembly.stacks).toHaveLength(1);
    expect(assembly.stacks[0]!.stackName).toBe('kepler-test-deploy');
  });

  it('produces expected CloudFormation outputs', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, unknown>>;
    const outputs = template['Outputs'] || {};
    const outputKeys = Object.keys(outputs);

    expect(outputKeys).toContain('InstanceId');
    expect(outputKeys).toContain('VpcId');
    expect(outputKeys).toContain('DocsBucketName');
    expect(outputKeys).toContain('LogGroupName');
    expect(outputKeys).toContain('Region');
    expect(outputKeys).toContain('DeploymentName');
  });

  it('creates VPC resources when vpcStrategy is create', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, Record<string, unknown>>>;
    const resources = template['Resources'] || {};

    const vpcResource = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::EC2::VPC',
    );
    expect(vpcResource).toBeDefined();
  });

  it('applies kepler tags to the stack', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const tags = assembly.stacks[0]!.tags;

    expect(tags['kepler:deployment']).toBe('test-deploy');
    expect(tags['kepler:managed']).toBe('true');
    expect(tags['kepler:version']).toBe('0.0.1');
  });

  it('scopes Bedrock permissions to the deployment region', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, Record<string, unknown>>>;
    const policyDoc = template['Resources'] || {};

    // Find the IAM policy that contains Bedrock statements
    const policyResource = Object.values(policyDoc).find(
      (r) => r['Type'] === 'AWS::IAM::Policy',
    );
    const statements = (
      (policyResource?.['Properties'] as Record<string, Record<string, unknown[]>>)?.['PolicyDocument']?.['Statement'] || []
    ) as Array<{ Sid?: string; Resource?: string }>;

    const bedrockStmt = statements.find((s) => s.Sid === 'BedrockInvoke');
    expect(bedrockStmt).toBeDefined();
    expect(bedrockStmt!.Resource).toBe('arn:aws:bedrock:us-east-1:*:*');
  });

  it('splits ECR permissions into auth and pull', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = JSON.stringify(assembly.stacks[0]!.template);

    // ECR auth on wildcard
    expect(template).toContain('ecr:GetAuthorizationToken');
    // ECR pull scoped to kepler repos
    expect(template).toContain('arn:aws:ecr:us-east-1:*:repository/kepler-*');
  });

  it('respects different instance tiers', () => {
    const largeConfig = { ...TEST_CONFIG, instanceTier: 'large' as const };
    const app = createApp(largeConfig);
    const assembly = app.synth();
    const template = JSON.stringify(assembly.stacks[0]!.template);

    expect(template).toContain('m7i.2xlarge');
  });

  it('creates doc events SQS queue and EventBridge rule', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, Record<string, unknown>>>;
    const resources = template['Resources'] || {};

    const sqsQueue = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::SQS::Queue' && JSON.stringify(r).includes('kepler-doc-events-test-deploy'),
    );
    expect(sqsQueue).toBeDefined();

    const rule = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::Events::Rule',
    );
    expect(rule).toBeDefined();
  });

  it('produces DocEventQueueUrl output', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, unknown>>;
    const outputs = template['Outputs'] || {};
    expect(Object.keys(outputs)).toContain('DocEventQueueUrl');
  });

  it('does not create Bedrock KB when enableBedrockKB is false', () => {
    const app = createApp(TEST_CONFIG);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, Record<string, unknown>>>;
    const resources = template['Resources'] || {};

    const kbResource = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::Bedrock::KnowledgeBase',
    );
    expect(kbResource).toBeUndefined();
  });

  it('creates Bedrock KB when enableBedrockKB is true', () => {
    const bedrockConfig = { ...TEST_CONFIG, enableBedrockKB: true };
    const app = createApp(bedrockConfig);
    const assembly = app.synth();
    const template = assembly.stacks[0]!.template as Record<string, Record<string, Record<string, unknown>>>;
    const resources = template['Resources'] || {};
    const outputs = template['Outputs'] || {};

    const kbResource = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::Bedrock::KnowledgeBase',
    );
    expect(kbResource).toBeDefined();

    const dsResource = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::Bedrock::DataSource',
    );
    expect(dsResource).toBeDefined();

    expect(Object.keys(outputs)).toContain('KnowledgeBaseId');
    expect(Object.keys(outputs)).toContain('DataSourceId');
  });
});
