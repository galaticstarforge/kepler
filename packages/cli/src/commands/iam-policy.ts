import { Command } from 'commander';

import { notImplemented } from '../not-implemented.js';

export const iamPolicyCommand = new Command('iam-policy')
  .description('Print or create the recommended IAM policy')
  .option('--create', 'Create the IAM policy in AWS')
  .action(notImplemented);
