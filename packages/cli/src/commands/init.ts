import { Command } from 'commander';

import { readLocalState, writeLocalState, getRegion } from '../lib/config.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkAwsCredentials } from '../lib/prerequisites.js';
import { promptConfirm, promptSelect } from '../lib/prompts.js';
import {
  findAllStateBuckets,
  createStateBucket,
  generateBucketName,
} from '../lib/state-bucket.js';

export const initCommand = new Command('init')
  .description('Initialize state bucket and local config')
  .action(async () => {
    try {
      await checkAwsCredentials();

      const existing = readLocalState();
      if (existing?.stateBucket) {
        output(
          isJsonOutput()
            ? { status: 'already_initialized', stateBucket: existing.stateBucket }
            : `Already initialized. State bucket: ${existing.stateBucket}`,
        );
        return;
      }

      const buckets = await findAllStateBuckets();
      let selectedBucket: string;

      if (buckets.length === 1) {
        const use = await promptConfirm(
          `Found existing state bucket "${buckets[0]}". Use it?`,
          true,
        );
        if (use) {
          selectedBucket = buckets[0]!;
        } else {
          const name = generateBucketName();
          logger.info(`Creating state bucket: ${name}`);
          await createStateBucket(name);
          selectedBucket = name;
        }
      } else if (buckets.length > 1) {
        selectedBucket = await promptSelect(
          'Multiple state buckets found. Select one:',
          buckets.map((b) => ({ name: b, value: b })),
        );
      } else {
        const create = await promptConfirm('No state bucket found. Create one?', true);
        if (!create) {
          logger.info('Aborted.');
          return;
        }
        const name = generateBucketName();
        logger.info(`Creating state bucket: ${name}`);
        await createStateBucket(name);
        selectedBucket = name;
      }

      const region = getRegion();
      writeLocalState({ stateBucket: selectedBucket, region });

      output(
        isJsonOutput()
          ? { status: 'initialized', stateBucket: selectedBucket, region }
          : `Initialized. State bucket: ${selectedBucket}\nNext: run \`kepler deploy <name>\``,
      );
    } catch (error) {
      handleError(error);
    }
  });
