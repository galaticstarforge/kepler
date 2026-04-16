import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const pluginCommand = new Command('plugin')
  .description('Manage plugins')
  .addCommand(
    new Command('upload')
      .description('Upload a plugin to the state bucket')
      .argument('<path>', 'Path to the plugin archive')
      .action(notImplemented),
  )
  .addCommand(
    new Command('enable')
      .description('Enable a plugin')
      .argument('<name>', 'Plugin name')
      .action(notImplemented),
  )
  .addCommand(
    new Command('disable')
      .description('Disable a plugin')
      .argument('<name>', 'Plugin name')
      .action(notImplemented),
  )
  .addCommand(new Command('list').description('List plugins').action(notImplemented))
  .addCommand(
    new Command('logs')
      .description('Tail plugin logs')
      .argument('<name>', 'Plugin name')
      .action(notImplemented),
  );
