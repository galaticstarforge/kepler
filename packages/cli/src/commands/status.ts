import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { getStatus } from '@kepler/installer';
import { Command } from 'commander';

import { getEC2Client } from '../lib/aws-clients.js';
import { readLocalState } from '../lib/config.js';
import { NotInitializedError, DeploymentNotFoundError } from '../lib/errors.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkAwsCredentials } from '../lib/prerequisites.js';


export const statusCommand = new Command('status')
  .description('Show deployment status')
  .argument('[deployment-name]', 'Deployment name')
  .action(async (deploymentName?: string) => {
    try {
      await checkAwsCredentials();
      const state = readLocalState();
      if (!state?.stateBucket) throw new NotInitializedError();

      const name = deploymentName || state.lastUsedDeployment;
      if (!name) {
        throw new DeploymentNotFoundError(
          '<none> — specify a deployment name or run `kepler deploy` first',
        );
      }

      const status = await getStatus(name, state.region);
      if (!status) {
        throw new DeploymentNotFoundError(name);
      }

      // Get instance details if we have an instance ID
      let instanceState = '';
      let instanceType = '';
      let privateIp = '';

      if (status.instanceId) {
        try {
          const ec2 = getEC2Client();
          const response = await ec2.send(
            new DescribeInstancesCommand({
              InstanceIds: [status.instanceId],
            }),
          );
          const instance = response.Reservations?.[0]?.Instances?.[0];
          if (instance) {
            instanceState = instance.State?.Name || '';
            instanceType = instance.InstanceType || '';
            privateIp = instance.PrivateIpAddress || '';
          }
        } catch {
          // Instance may have been terminated
        }
      }

      const result = {
        ...status,
        instanceState,
        instanceType,
        privateIp,
      };

      if (isJsonOutput()) {
        output(result);
      } else {
        logger.info(`Deployment: ${name}`);
        logger.info(`Status:     ${status.status}`);
        logger.info(`Stack:      ${status.stackName}`);
        logger.info(`Instance:   ${status.instanceId}`);
        logger.info(`VPC:        ${status.vpcId}`);
        logger.info(`Docs:       ${status.docsBucketName}`);
        logger.info(`Logs:       ${status.logGroupName}`);
        logger.info(`Region:     ${status.region}`);
        if (instanceState) {
          logger.info(`\nInstance State: ${instanceState}`);
          logger.info(`Instance Type:  ${instanceType}`);
          logger.info(`Private IP:     ${privateIp}`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
