import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const deployCommand = new Command('deploy')
  .description('Deploy or update a Kepler stack')
  .action(notImplemented);
