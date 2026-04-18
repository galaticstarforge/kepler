import { DescribeInstanceInformationCommand } from '@aws-sdk/client-ssm';
import { getStatus } from '@keplerforge/installer';
import { Command } from 'commander';

import { getSSMClient } from '../lib/aws-clients.js';
import { readLocalState } from '../lib/config.js';
import { NotInitializedError, DeploymentNotFoundError } from '../lib/errors.js';
import { logger, handleError } from '../lib/logger.js';
import { checkPrerequisites } from '../lib/prerequisites.js';


export const tunnelCommand = new Command('tunnel')
  .description('Open SSM port-forwarding tunnel to the deployment')
  .argument('[deployment-name]', 'Deployment name')
  .option('--local-port <port>', 'Local port to forward to', '8080')
  .action(async (deploymentName?: string, options?: { localPort?: string }) => {
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

      // Check SSM agent readiness
      const ssm = getSSMClient();
      try {
        const ssmInfo = await ssm.send(
          new DescribeInstanceInformationCommand({
            Filters: [
              { Key: 'InstanceIds', Values: [status.instanceId] },
            ],
          }),
        );
        const info = ssmInfo.InstanceInformationList?.[0];
        if (!info || info.PingStatus !== 'Online') {
          logger.error(
            'SSM agent not yet ready. Wait 1-2 minutes after deployment and try again.',
          );
          process.exit(1);
        }
      } catch {
        logger.error(
          'Could not verify SSM agent status. The instance may not be ready yet.',
        );
        process.exit(1);
      }

      const localPort = options?.localPort || '8080';
      const { execa } = await import('execa');

      logger.info(
        `Tunnel established: localhost:${localPort} → ${status.instanceId}:8080`,
      );
      logger.info(`MCP endpoint: http://localhost:${localPort}`);
      logger.info('Press Ctrl-C to disconnect.');

      const proc = execa(
        'aws',
        [
          'ssm',
          'start-session',
          '--target',
          status.instanceId,
          '--document-name',
          'AWS-StartPortForwardingSession',
          '--parameters',
          JSON.stringify({
            portNumber: ['8080'],
            localPortNumber: [localPort],
          }),
          '--region',
          state.region,
        ],
        { stdio: 'inherit', reject: false },
      );

      process.on('SIGINT', () => {
        proc.kill('SIGTERM');
      });

      await proc;
      logger.info('Tunnel closed.');
    } catch (error) {
      handleError(error);
    }
  });
