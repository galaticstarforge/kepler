import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const initCommand = new Command('init')
  .description('Initialize state bucket and local config')
  .action(notImplemented);
