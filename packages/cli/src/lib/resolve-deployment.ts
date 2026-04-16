import { getStatus } from '@kepler/installer';

import { readLocalState } from './config.js';
import { NotInitializedError } from './errors.js';
import { logger } from './logger.js';

export interface ActiveDeployment {
  deploymentName: string;
  stateBucket: string;
  region: string;
  instanceId: string;
}

export async function getActiveDeployment(): Promise<ActiveDeployment> {
  const state = readLocalState();
  if (!state?.stateBucket) throw new NotInitializedError();

  const deploymentName = state.lastUsedDeployment;
  if (!deploymentName) {
    logger.error('No active deployment. Run `kepler deploy` first.');
    process.exit(1);
  }

  const status = await getStatus(deploymentName, state.region);
  if (!status) {
    logger.error(`Deployment "${deploymentName}" not found.`);
    process.exit(1);
  }

  return {
    deploymentName,
    stateBucket: state.stateBucket,
    region: state.region,
    instanceId: status.instanceId,
  };
}
