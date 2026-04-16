import * as cdk from 'aws-cdk-lib';

import { KeplerStack } from './stacks/kepler-stack.js';
import type { DeploymentConfig } from './types.js';

export function createApp(config: DeploymentConfig): cdk.App {
  const app = new cdk.App();

  new KeplerStack(app, `kepler-${config.deploymentName}`, {
    config,
    env: {
      region: config.region,
    },
    description: `Kepler deployment: ${config.deploymentName}`,
  });

  return app;
}
