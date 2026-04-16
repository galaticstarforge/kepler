import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import type { DeploymentConfig } from '../types.js';

import { KeplerIam } from './constructs/kepler-iam.js';
import { KeplerInstance } from './constructs/kepler-instance.js';
import { KeplerStorage } from './constructs/kepler-storage.js';
import { KeplerVpc } from './constructs/kepler-vpc.js';


export interface KeplerStackProps extends cdk.StackProps {
  config: DeploymentConfig;
}

const INSTANCE_TIER_MAP: Record<string, { instanceType: string; volumeSize: number }> = {
  small: { instanceType: 't3.large', volumeSize: 100 },
  medium: { instanceType: 'm7i.large', volumeSize: 200 },
  large: { instanceType: 'm7i.2xlarge', volumeSize: 400 },
};

export class KeplerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KeplerStackProps) {
    super(scope, id, props);

    const { config } = props;
    const tierConfig = INSTANCE_TIER_MAP[config.instanceTier] || INSTANCE_TIER_MAP['small']!;

    cdk.Tags.of(this).add('kepler:deployment', config.deploymentName);
    cdk.Tags.of(this).add('kepler:managed', 'true');
    cdk.Tags.of(this).add('kepler:version', config.keplerVersion);

    // VPC
    const vpcConstruct = new KeplerVpc(this, 'Vpc', {
      deploymentName: config.deploymentName,
      vpcStrategy: config.vpcStrategy,
      existingVpcId: config.existingVpcId,
    });

    // Storage
    const storage = new KeplerStorage(this, 'Storage', {
      deploymentName: config.deploymentName,
    });

    // IAM
    const iam = new KeplerIam(this, 'Iam', {
      deploymentName: config.deploymentName,
      stateBucketName: config.stateBucketName,
      docsBucket: storage.docsBucket,
      logGroup: storage.logGroup,
    });

    // EC2 Instance
    const instance = new KeplerInstance(this, 'Instance', {
      deploymentName: config.deploymentName,
      vpc: vpcConstruct.vpc,
      instanceRole: iam.instanceRole,
      instanceType: tierConfig.instanceType,
      volumeSize: tierConfig.volumeSize,
      keplerVersion: config.keplerVersion,
      stateBucketName: config.stateBucketName,
      logGroupName: storage.logGroup.logGroupName,
      region: config.region,
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instance.instanceId });
    new cdk.CfnOutput(this, 'VpcId', { value: vpcConstruct.vpc.vpcId });
    new cdk.CfnOutput(this, 'DocsBucketName', { value: storage.docsBucket.bucketName });
    new cdk.CfnOutput(this, 'LogGroupName', { value: storage.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'Region', { value: config.region });
    new cdk.CfnOutput(this, 'DeploymentName', { value: config.deploymentName });
  }
}
