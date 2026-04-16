import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { readLocalState, getRegion } from '../lib/config.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const versionCommand = new Command('info')
  .description('Show version and environment info')
  .action(async () => {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
      ) as { version: string };

      const state = readLocalState();
      const region = getRegion();

      let account = '';
      let identity = '';
      try {
        const { checkAwsCredentials } = await import('../lib/prerequisites.js');
        const caller = await checkAwsCredentials();
        account = caller.account;
        identity = caller.arn;
      } catch {
        // AWS credentials not available
      }

      const info = {
        version: pkg.version,
        node: process.version,
        region,
        stateBucket: state?.stateBucket || null,
        lastUsedDeployment: state?.lastUsedDeployment || null,
        awsAccount: account || null,
        awsIdentity: identity || null,
      };

      if (isJsonOutput()) {
        output(info);
      } else {
        logger.info(`Kepler CLI v${pkg.version}`);
        logger.info(`Node:       ${process.version}`);
        logger.info(`Region:     ${region}`);
        logger.info(`State:      ${state?.stateBucket || '(not initialized)'}`);
        logger.info(`Deployment: ${state?.lastUsedDeployment || '(none)'}`);
        if (account) {
          logger.info(`Account:    ${account}`);
          logger.info(`Identity:   ${identity}`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
