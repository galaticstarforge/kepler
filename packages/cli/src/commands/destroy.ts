import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const destroyCommand = new Command('destroy')
  .description('Tear down a deployment')
  .action(notImplemented);
