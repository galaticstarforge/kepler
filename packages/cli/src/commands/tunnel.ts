import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const tunnelCommand = new Command('tunnel')
  .description('Open SSM port-forwarding tunnel to the deployment')
  .action(notImplemented);
