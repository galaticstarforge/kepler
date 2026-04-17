import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface KeplerBedrockProps {
  deploymentName: string;
  docsBucket: s3.IBucket;
  docsPrefix: string;
  region: string;
  embeddingModelId?: string;
}

export class KeplerBedrock extends Construct {
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: KeplerBedrockProps) {
    super(scope, id);

    const embeddingModel = props.embeddingModelId ?? 'amazon.titan-embed-text-v2:0';

    // IAM role for the Bedrock KB to read from S3.
    const kbRole = new iam.Role(this, 'KbRole', {
      roleName: `kepler-kb-${props.deploymentName}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Bedrock Knowledge Base role for Kepler ${props.deploymentName}`,
    });

    props.docsBucket.grantRead(kbRole);

    cdk.Tags.of(kbRole).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(kbRole).add('kepler:managed', 'true');

    // Knowledge Base (L1 construct).
    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `kepler-${props.deploymentName}`,
      description: `Kepler documentation knowledge base for ${props.deploymentName}`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${props.region}::foundation-model/${embeddingModel}`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: '', // Placeholder — requires an OpenSearch Serverless collection.
          vectorIndexName: `kepler-${props.deploymentName}`,
          fieldMapping: {
            vectorField: 'embedding',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    cdk.Tags.of(kb).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(kb).add('kepler:managed', 'true');

    // Data source pointing at the docs S3 bucket.
    const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      name: `kepler-docs-${props.deploymentName}`,
      description: 'Kepler documentation store',
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.docsBucket.bucketArn,
          inclusionPrefixes: [props.docsPrefix],
        },
      },
    });

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;
  }
}
