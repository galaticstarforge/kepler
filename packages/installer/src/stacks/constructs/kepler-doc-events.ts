import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface KeplerDocEventsProps {
  deploymentName: string;
  docsBucket: s3.IBucket;
}

export class KeplerDocEvents extends Construct {
  public readonly eventQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: KeplerDocEventsProps) {
    super(scope, id);

    // Dead-letter queue for failed event processing.
    const dlq = new sqs.Queue(this, 'DocEventsDlq', {
      queueName: `kepler-doc-events-dlq-${props.deploymentName}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    cdk.Tags.of(dlq).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(dlq).add('kepler:managed', 'true');

    // Main event queue for document change events.
    this.eventQueue = new sqs.Queue(this, 'DocEventsQueue', {
      queueName: `kepler-doc-events-${props.deploymentName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    cdk.Tags.of(this.eventQueue).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(this.eventQueue).add('kepler:managed', 'true');

    // EventBridge rule matching S3 object-level events on the docs bucket.
    const rule = new events.Rule(this, 'DocChangeRule', {
      ruleName: `kepler-doc-changes-${props.deploymentName}`,
      description: `Route S3 object events for Kepler docs bucket (${props.deploymentName})`,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created', 'Object Deleted'],
        detail: {
          bucket: { name: [props.docsBucket.bucketName] },
        },
      },
    });

    rule.addTarget(new targets.SqsQueue(this.eventQueue));

    cdk.Tags.of(rule).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(rule).add('kepler:managed', 'true');
  }
}
