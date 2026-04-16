import {
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getStatus, destroy } from '@kepler/installer';
import { Command } from 'commander';
import ora from 'ora';

import { getS3Client } from '../lib/aws-clients.js';
import { readLocalState, updateLocalState } from '../lib/config.js';
import { NotInitializedError, DeploymentNotFoundError } from '../lib/errors.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkAwsCredentials } from '../lib/prerequisites.js';
import { promptInput } from '../lib/prompts.js';
import { archiveDeploymentConfig, recordHistoryEntry } from '../lib/state-bucket.js';


async function emptyBucket(bucketName: string): Promise<void> {
  const s3 = getS3Client();
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucketName,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );

    const objects = [
      ...(response.Versions || []).map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId,
      })),
      ...(response.DeleteMarkers || []).map((d) => ({
        Key: d.Key!,
        VersionId: d.VersionId,
      })),
    ];

    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }

    keyMarker = response.NextKeyMarker;
    versionIdMarker = response.NextVersionIdMarker;
  } while (keyMarker);
}

export const destroyCommand = new Command('destroy')
  .description('Tear down a deployment')
  .argument('<deployment-name>', 'Name of the deployment to destroy')
  .option('--keep-docs-bucket', 'Skip emptying the docs bucket')
  .action(async (deploymentName: string, options: { keepDocsBucket?: boolean }) => {
    try {
      await checkAwsCredentials();
      const state = readLocalState();
      if (!state?.stateBucket) throw new NotInitializedError();

      const status = await getStatus(deploymentName, state.region);
      if (!status) {
        throw new DeploymentNotFoundError(deploymentName);
      }

      // Confirm with typed name
      const confirmation = await promptInput(
        `This will permanently delete deployment "${deploymentName}" including its docs bucket.\nType the deployment name to confirm:`,
      );
      if (confirmation !== deploymentName) {
        logger.info('Confirmation did not match. Aborted.');
        return;
      }

      // Empty docs bucket unless --keep-docs-bucket
      if (!options.keepDocsBucket && status.docsBucketName) {
        const spinner = ora('Emptying docs bucket...').start();
        try {
          await emptyBucket(status.docsBucketName);
          spinner.succeed('Docs bucket emptied.');
        } catch {
          spinner.warn('Could not empty docs bucket. CloudFormation may fail to delete it.');
        }
      }

      // Destroy the stack
      const spinner = ora('Destroying stack...').start();
      await destroy(deploymentName, state.region, (msg) => {
        spinner.text = msg;
      });
      spinner.succeed('Stack destroyed.');

      // Archive deployment config
      await archiveDeploymentConfig(state.stateBucket, deploymentName);

      await recordHistoryEntry(state.stateBucket, deploymentName, 'destroy', {
        timestamp: new Date().toISOString(),
      });

      // Clear lastUsedDeployment if it was this one
      if (state.lastUsedDeployment === deploymentName) {
        updateLocalState({ lastUsedDeployment: undefined });
      }

      output(
        isJsonOutput()
          ? { status: 'destroyed', deploymentName }
          : `Deployment "${deploymentName}" has been destroyed.`,
      );
    } catch (error) {
      handleError(error);
    }
  });
