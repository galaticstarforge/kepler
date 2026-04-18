import { getStatus } from '@keplerforge/installer';
import { Command } from 'commander';

import { readLocalState } from '../lib/config.js';
import { NotInitializedError, DeploymentNotFoundError } from '../lib/errors.js';
import { logger, handleError } from '../lib/logger.js';
import { checkPrerequisites } from '../lib/prerequisites.js';

export const sshCommand = new Command('ssh')
  .description('Open SSM session shell on the instance')
  .argument('[deployment-name]', 'Deployment name')
  .action(async (deploymentName?: string) => {
    try {
      await checkPrerequisites({ requireSsmPlugin: true });
      const state = readLocalState();
      if (!state?.stateBucket) throw new NotInitializedError();

      const name = deploymentName || state.lastUsedDeployment;
      if (!name) {
        throw new DeploymentNotFoundError(
          '<none> — specify a deployment name or run `kepler deploy` first',
        );
      }

      const status = await getStatus(name, state.region);
      if (!status?.instanceId) {
        throw new DeploymentNotFoundError(name);
      }

      const { execa } = await import('execa');

      logger.info(`Opening shell on ${status.instanceId}...`);

      const proc = execa(
        'aws',
        [
          'ssm',
          'start-session',
          '--target',
          status.instanceId,
          '--region',
          state.region,
        ],
        { stdio: 'inherit', reject: false },
      );

      process.on('SIGINT', () => {
        proc.kill('SIGTERM');
      });

      await proc;
    } catch (error) {
      handleError(error);
    }
  });
