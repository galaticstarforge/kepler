import { Command } from 'commander';

import { readLocalState } from '../lib/config.js';
import { NotInitializedError } from '../lib/errors.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkAwsCredentials } from '../lib/prerequisites.js';
import { readDeploymentConfig, writeDeploymentConfig } from '../lib/state-bucket.js';

const WRITABLE_KEYS = new Set(['instanceTier']);

export const configCommand = new Command('config')
  .description('Read/write deployment config')
  .addCommand(
    new Command('get')
      .description('Get a config value')
      .argument('<key>', 'Config key')
      .option('--deployment <name>', 'Deployment name')
      .action(async (key: string, options: { deployment?: string }) => {
        try {
          await checkAwsCredentials();
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();

          const deploymentName = options.deployment || state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No deployment specified. Use --deployment or run `kepler deploy` first.');
            process.exit(1);
          }

          const config = await readDeploymentConfig(state.stateBucket, deploymentName);
          if (!config) {
            logger.error(`No config found for deployment "${deploymentName}".`);
            process.exit(1);
          }

          const value = config[key];
          if (isJsonOutput()) {
            output({ key, value });
          } else {
            logger.info(`${key} = ${value === undefined ? '(not set)' : String(value)}`);
          }
        } catch (error) {
          handleError(error);
        }
      }),
  )
  .addCommand(
    new Command('set')
      .description('Set a config value')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Config value')
      .option('--deployment <name>', 'Deployment name')
      .action(async (key: string, value: string, options: { deployment?: string }) => {
        try {
          await checkAwsCredentials();
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();

          if (!WRITABLE_KEYS.has(key)) {
            logger.error(`Key "${key}" is read-only. Writable keys: ${[...WRITABLE_KEYS].join(', ')}`);
            process.exit(1);
          }

          const deploymentName = options.deployment || state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No deployment specified. Use --deployment or run `kepler deploy` first.');
            process.exit(1);
          }

          const config = await readDeploymentConfig(state.stateBucket, deploymentName) || {};
          config[key] = value;
          await writeDeploymentConfig(state.stateBucket, deploymentName, config);

          if (isJsonOutput()) {
            output({ key, value, status: 'set' });
          } else {
            logger.info(`${key} = ${value}`);
            if (key === 'instanceTier') {
              logger.warn('Requires `kepler deploy` to apply the change.');
            }
          }
        } catch (error) {
          handleError(error);
        }
      }),
  );
