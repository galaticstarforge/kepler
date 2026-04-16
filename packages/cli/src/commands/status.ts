import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const statusCommand = new Command('status')
  .description('Show deployment status')
  .action(notImplemented);
