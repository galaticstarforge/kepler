import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';

import { getRegion } from './config.js';

let _s3: S3Client | undefined;
let _cfn: CloudFormationClient | undefined;
let _ec2: EC2Client | undefined;
let _ssm: SSMClient | undefined;
let _sts: STSClient | undefined;
let _iam: IAMClient | undefined;
let _logs: CloudWatchLogsClient | undefined;

export function getS3Client(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: getRegion() });
  return _s3;
}

export function getCloudFormationClient(): CloudFormationClient {
  if (!_cfn) _cfn = new CloudFormationClient({ region: getRegion() });
  return _cfn;
}

export function getEC2Client(): EC2Client {
  if (!_ec2) _ec2 = new EC2Client({ region: getRegion() });
  return _ec2;
}

export function getSSMClient(): SSMClient {
  if (!_ssm) _ssm = new SSMClient({ region: getRegion() });
  return _ssm;
}

export function getSTSClient(): STSClient {
  if (!_sts) _sts = new STSClient({ region: getRegion() });
  return _sts;
}

export function getIAMClient(): IAMClient {
  if (!_iam) _iam = new IAMClient({ region: getRegion() });
  return _iam;
}

export function getLogsClient(): CloudWatchLogsClient {
  if (!_logs) _logs = new CloudWatchLogsClient({ region: getRegion() });
  return _logs;
}
