import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { EC2Client } from '@aws-sdk/client-ec2';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';

import { getRegion } from './config.js';

export function createS3Client(): S3Client {
  return new S3Client({ region: getRegion() });
}

export function createCloudFormationClient(): CloudFormationClient {
  return new CloudFormationClient({ region: getRegion() });
}

export function createEC2Client(): EC2Client {
  return new EC2Client({ region: getRegion() });
}

export function createSSMClient(): SSMClient {
  return new SSMClient({ region: getRegion() });
}
