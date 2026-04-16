import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface KeplerStorageProps {
  deploymentName: string;
}

export class KeplerStorage extends Construct {
  public readonly docsBucket: s3.Bucket;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: KeplerStorageProps) {
    super(scope, id);

    this.docsBucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    cdk.Tags.of(this.docsBucket).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(this.docsBucket).add('kepler:managed', 'true');

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/kepler/${props.deploymentName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
