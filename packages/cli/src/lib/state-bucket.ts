import {
  ListBucketsCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  PutBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  type BucketLocationConstraint,
  type CreateBucketCommandInput,
} from '@aws-sdk/client-s3';

import { getS3Client } from './aws-clients.js';
import { getRegion } from './config.js';

const STATE_BUCKET_PREFIX = 'kepler-state-';

export async function findStateBucket(): Promise<string | undefined> {
  const s3 = getS3Client();
  const response = await s3.send(new ListBucketsCommand({}));
  const buckets = (response.Buckets || [])
    .filter((b) => b.Name?.startsWith(STATE_BUCKET_PREFIX))
    .map((b) => b.Name!);

  if (buckets.length === 1) return buckets[0];
  if (buckets.length > 1) return buckets[0]; // Caller should handle selection
  return undefined;
}

export async function findAllStateBuckets(): Promise<string[]> {
  const s3 = getS3Client();
  const response = await s3.send(new ListBucketsCommand({}));
  return (response.Buckets || [])
    .filter((b) => b.Name?.startsWith(STATE_BUCKET_PREFIX))
    .map((b) => b.Name!);
}

export async function createStateBucket(name: string): Promise<void> {
  const s3 = getS3Client();
  const region = getRegion();

  const createParams: CreateBucketCommandInput = {
    Bucket: name,
  };

  // us-east-1 does not accept a LocationConstraint
  if (region !== 'us-east-1') {
    createParams.CreateBucketConfiguration = {
      LocationConstraint: region as BucketLocationConstraint,
    };
  }

  await s3.send(new CreateBucketCommand(createParams));

  // Enable versioning
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: name,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );

  // Enable SSE-S3
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: name,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    }),
  );

  // Block public access
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  // Lifecycle rule for noncurrent versions
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: name,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-noncurrent',
            Status: 'Enabled',
            NoncurrentVersionExpiration: {
              NoncurrentDays: 90,
            },
            Filter: { Prefix: '' },
          },
        ],
      },
    }),
  );
}

export function generateBucketName(): string {
  const suffix = Array.from({ length: 6 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)],
  ).join('');
  return `${STATE_BUCKET_PREFIX}${suffix}`;
}

export async function readDeploymentConfig(
  bucket: string,
  deploymentName: string,
): Promise<Record<string, unknown> | null> {
  const s3 = getS3Client();
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `deployments/${deploymentName}/config.json`,
      }),
    );
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as Record<string, unknown>) : null;
  } catch (error: unknown) {
    const code = (error as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'AccessDenied') return null;
    throw error;
  }
}

export async function writeDeploymentConfig(
  bucket: string,
  deploymentName: string,
  config: Record<string, unknown>,
): Promise<void> {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `deployments/${deploymentName}/config.json`,
      Body: JSON.stringify(config, null, 2),
      ContentType: 'application/json',
    }),
  );
}

export async function listDeployments(bucket: string): Promise<string[]> {
  const s3 = getS3Client();
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'deployments/',
      Delimiter: '/',
    }),
  );

  return (response.CommonPrefixes || [])
    .map((p) => p.Prefix?.replace('deployments/', '').replace('/', '') || '')
    .filter(Boolean);
}

export async function recordHistoryEntry(
  bucket: string,
  deploymentName: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const s3 = getS3Client();
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    action,
    deploymentName,
    details,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `deployments/${deploymentName}/history/${timestamp.replaceAll(/[:.]/g, '-')}.json`,
      Body: JSON.stringify(entry, null, 2),
      ContentType: 'application/json',
    }),
  );
}

export async function archiveDeploymentConfig(
  bucket: string,
  deploymentName: string,
): Promise<void> {
  const s3 = getS3Client();
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');

  try {
    // Copy to archive
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/deployments/${deploymentName}/config.json`,
        Key: `archive/${deploymentName}-${timestamp}/config.json`,
      }),
    );

    // Delete original
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: `deployments/${deploymentName}/config.json`,
      }),
    );
  } catch {
    // If config doesn't exist, that's fine
  }
}
