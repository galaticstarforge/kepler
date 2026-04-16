import {
  deploy,
  getStatus,
  type DeploymentConfig,
} from '@kepler/installer';
import { Command } from 'commander';
import ora from 'ora';

import { readLocalState, updateLocalState } from '../lib/config.js';
import { NotInitializedError } from '../lib/errors.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkPrerequisites } from '../lib/prerequisites.js';
import { promptConfirm, promptSelect } from '../lib/prompts.js';
import { writeDeploymentConfig, recordHistoryEntry } from '../lib/state-bucket.js';

const TIER_CHOICES = [
  { name: 'small  — t3.large, 100 GB (~$70/month)', value: 'small' as const },
  { name: 'medium — m7i.large, 200 GB (~$120/month)', value: 'medium' as const },
  { name: 'large  — m7i.2xlarge, 400 GB (~$280/month)', value: 'large' as const },
];

const VPC_CHOICES = [
  { name: 'Create new VPC', value: 'create' as const },
  { name: 'Use default VPC', value: 'default' as const },
];

export const deployCommand = new Command('deploy')
  .description('Deploy or update a Kepler stack')
  .argument('<deployment-name>', 'Name for the deployment')
  .option('--tier <tier>', 'Instance tier (small/medium/large)')
  .option('--vpc <strategy>', 'VPC strategy (create/default)')
  .action(async (deploymentName: string, options: { tier?: string; vpc?: string }) => {
    try {
      const { identity } = await checkPrerequisites({ requireSsmPlugin: true });
      const state = readLocalState();
      if (!state?.stateBucket) {
        throw new NotInitializedError();
      }

      const region = state.region;
      const existingStatus = await getStatus(deploymentName, region);

      if (existingStatus) {
        const s = existingStatus.status;
        if (s.includes('IN_PROGRESS')) {
          logger.error(`Deployment "${deploymentName}" is in progress (${s}). Try again later.`);
          process.exit(1);
        }
        if (s === 'ROLLBACK_COMPLETE' || s.includes('FAILED')) {
          const recreate = await promptConfirm(
            `Deployment is in failed state (${s}). Delete and recreate?`,
          );
          if (!recreate) {
            logger.info('Aborted.');
            return;
          }
          const { destroy } = await import('@kepler/installer');
          const spinner = ora('Cleaning up failed stack...').start();
          await destroy(deploymentName, region, (msg) => { spinner.text = msg; });
          spinner.succeed('Old stack removed.');
        } else if (s === 'CREATE_COMPLETE' || s === 'UPDATE_COMPLETE') {
          const update = await promptConfirm('Deployment exists. Update?');
          if (!update) {
            logger.info('Aborted.');
            return;
          }
        }
      }

      // Gather config
      const tier = (options.tier as 'small' | 'medium' | 'large') ||
        await promptSelect('Select instance tier:', TIER_CHOICES);

      const vpcStrategy = (options.vpc as 'create' | 'default') ||
        await promptSelect('VPC strategy:', VPC_CHOICES);

      const config: DeploymentConfig = {
        deploymentName,
        region,
        stateBucketName: state.stateBucket,
        instanceTier: tier,
        vpcStrategy,
        keplerVersion: '0.0.1',
      };

      if (!isJsonOutput()) {
        logger.info(`\nDeployment summary:`);
        logger.info(`  Name:     ${deploymentName}`);
        logger.info(`  Tier:     ${tier}`);
        logger.info(`  VPC:      ${vpcStrategy}`);
        logger.info(`  Region:   ${region}`);
        logger.info('');
      }

      const confirmed = await promptConfirm('Proceed with deployment?');
      if (!confirmed) {
        logger.info('Aborted.');
        return;
      }

      const spinner = ora('Deploying...').start();
      const outputs = await deploy(config, (msg) => {
        spinner.text = msg;
      });
      spinner.succeed('Deployment complete!');

      // Store config in state bucket
      await writeDeploymentConfig(state.stateBucket, deploymentName, {
        ...config,
        createdAt: new Date().toISOString(),
        createdBy: identity.arn,
      });

      await recordHistoryEntry(state.stateBucket, deploymentName, 'deploy', {
        tier,
        vpcStrategy,
        region,
        identity: identity.arn,
      });

      updateLocalState({ lastUsedDeployment: deploymentName });

      if (isJsonOutput()) {
        output(outputs);
      } else {
        logger.info(`\nDeployment: ${deploymentName}`);
        logger.info(`Instance:   ${outputs.instanceId}`);
        logger.info(`Stack:      ${outputs.stackName}`);
        logger.info(`\nNext: run \`kepler tunnel\``);
      }
    } catch (error) {
      handleError(error);
    }
  });
