import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const configCommand = new Command('config')
  .description('Read/write deployment config')
  .addCommand(
    new Command('get')
      .description('Get a config value')
      .argument('<key>', 'Config key')
      .action(notImplemented),
  )
  .addCommand(
    new Command('set')
      .description('Set a config value')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Config value')
      .action(notImplemented),
  );
