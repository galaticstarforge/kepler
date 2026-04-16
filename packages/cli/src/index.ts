import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { configCommand } from './commands/config.js';
import { deployCommand } from './commands/deploy.js';
import { destroyCommand } from './commands/destroy.js';
import { discoverCommand } from './commands/discover.js';
import { iamPolicyCommand } from './commands/iam-policy.js';
import { initCommand } from './commands/init.js';
import { pluginCommand } from './commands/plugin.js';
import { sshCommand } from './commands/ssh.js';
import { statusCommand } from './commands/status.js';
import { tunnelCommand } from './commands/tunnel.js';
import { versionCommand } from './commands/version.js';
import { setRegionOverride } from './lib/config.js';
import { setJsonOutput, setYesMode } from './lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};

const program = new Command()
  .name('kepler')
  .description(
    'Neo4j-backed code graph and markdown knowledge base with an MCP server for AI coding assistants',
  )
  .version(pkg.version)
  .option('--json', 'Output in JSON format')
  .option('--region <region>', 'Override AWS region')
  .option('--yes', 'Skip all confirmation prompts')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts<{ json?: boolean; region?: string; yes?: boolean }>();
    if (opts.json) {
      setJsonOutput(true);
    }
    if (opts.region) {
      setRegionOverride(opts.region);
    }
    if (opts.yes) {
      setYesMode(true);
    }
  });

program.addCommand(initCommand);
program.addCommand(deployCommand);
program.addCommand(statusCommand);
program.addCommand(destroyCommand);
program.addCommand(discoverCommand);
program.addCommand(tunnelCommand);
program.addCommand(sshCommand);
program.addCommand(pluginCommand);
program.addCommand(iamPolicyCommand);
program.addCommand(configCommand);
program.addCommand(versionCommand);

program.parse();
