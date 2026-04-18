import { getStatus } from '@keplerforge/installer';
import { Command } from 'commander';

import { writeLocalState, getRegion } from '../lib/config.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkAwsCredentials } from '../lib/prerequisites.js';
import { promptSelect } from '../lib/prompts.js';
import { findAllStateBuckets, listDeployments } from '../lib/state-bucket.js';

export const discoverCommand = new Command('discover')
  .description('Auto-discover existing state buckets')
  .action(async () => {
    try {
      await checkAwsCredentials();

      const buckets = await findAllStateBuckets();
      if (buckets.length === 0) {
        logger.error('No state buckets found in this AWS account.');
        logger.info('Run `kepler init` to create one.');
        process.exit(1);
      }

      let selectedBucket: string;
      if (buckets.length === 1) {
        selectedBucket = buckets[0]!;
        logger.info(`Found state bucket: ${selectedBucket}`);
      } else {
        selectedBucket = await promptSelect(
          'Multiple state buckets found. Select one:',
          buckets.map((b) => ({ name: b, value: b })),
        );
      }

      const deploymentNames = await listDeployments(selectedBucket);
      const region = getRegion();

      const deployments = await Promise.all(
        deploymentNames.map(async (name) => {
          const status = await getStatus(name, region).catch(() => null);
          return { name, status: status?.status || 'UNKNOWN' };
        }),
      );

      writeLocalState({ stateBucket: selectedBucket, region });

      if (isJsonOutput()) {
        output({ stateBucket: selectedBucket, deployments });
      } else {
        logger.info(`State bucket: ${selectedBucket}`);
        if (deployments.length === 0) {
          logger.info('No deployments found.');
        } else {
          logger.info('Deployments:');
          for (const d of deployments) {
            logger.info(`  ${d.name} — ${d.status}`);
          }
        }
        logger.info('Discovered. Next: run `kepler tunnel` (or `kepler tunnel <deployment>` if multiple)');
      }
    } catch (error) {
      handleError(error);
    }
  });
