import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const sshCommand = new Command('ssh')
  .description('Open SSM session shell on the instance')
  .action(notImplemented);
