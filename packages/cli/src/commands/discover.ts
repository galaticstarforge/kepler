import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const discoverCommand = new Command('discover')
  .description('Auto-discover existing state buckets')
  .action(notImplemented);
