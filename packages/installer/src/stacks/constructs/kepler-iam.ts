import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface KeplerIamProps {
  deploymentName: string;
  region: string;
  stateBucketName: string;
  docsBucket: s3.IBucket;
  logGroup: logs.ILogGroup;
}

export class KeplerIam extends Construct {
  public readonly instanceRole: iam.IRole;

  constructor(scope: Construct, id: string, props: KeplerIamProps) {
    super(scope, id);

    const role = new iam.Role(this, 'InstanceRole', {
      roleName: `kepler-instance-${props.deploymentName}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `Kepler instance role for deployment ${props.deploymentName}`,
    });

    // SSM Managed Instance Core (for Session Manager access)
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    // S3 read on state bucket
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StateBucketRead',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${props.stateBucketName}`,
          `arn:aws:s3:::${props.stateBucketName}/*`,
        ],
      }),
    );

    // S3 read/write on docs bucket
    props.docsBucket.grantReadWrite(role);

    // Bedrock invoke — scoped to deployment region
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:aws:bedrock:${props.region}:*:*`],
      }),
    );

    // CloudWatch Logs write
    props.logGroup.grantWrite(role);

    // ECR auth (requires resource '*')
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuth',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // ECR pull — scoped to kepler repositories in deployment region
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPull',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        resources: [`arn:aws:ecr:${props.region}:*:repository/kepler-*`],
      }),
    );

    cdk.Tags.of(role).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(role).add('kepler:managed', 'true');

    this.instanceRole = role;
  }
}
