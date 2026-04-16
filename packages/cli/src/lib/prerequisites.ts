import { execSync } from 'node:child_process';

import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';

import { getSTSClient } from './aws-clients.js';

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

export async function checkAwsCredentials(): Promise<CallerIdentity> {
  try {
    const sts = getSTSClient();
    const response = await sts.send(new GetCallerIdentityCommand({}));
    return {
      account: response.Account || '',
      arn: response.Arn || '',
      userId: response.UserId || '',
    };
  } catch {
    throw new Error(
      'AWS credentials not configured or expired. Configure credentials via environment variables, AWS CLI profiles, or SSO.',
    );
  }
}

export function checkAwsCli(): boolean {
  try {
    execSync('aws --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function checkSsmPlugin(): boolean {
  try {
    execSync('session-manager-plugin', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    // session-manager-plugin exits non-zero when called without args but still proves it's installed
    try {
      execSync('session-manager-plugin --version', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch (error: unknown) {
      // If the error is because the command was found but returned a non-zero exit,
      // it's still installed. Check if it's a "command not found" type error.
      const err = error as { status?: number; stderr?: Buffer };
      if (err.status !== undefined && err.status !== 127) return true;
      return false;
    }
  }
}

export interface PrerequisiteOptions {
  requireSsmPlugin?: boolean;
  requireDocker?: boolean;
}

export interface PrerequisiteResult {
  identity: CallerIdentity;
  awsCli: boolean;
  ssmPlugin: boolean;
}

export async function checkPrerequisites(
  options: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const identity = await checkAwsCredentials();
  const awsCli = checkAwsCli();
  const ssmPlugin = options.requireSsmPlugin ? checkSsmPlugin() : true;

  if (!awsCli) {
    throw new Error(
      'AWS CLI v2 is not installed. Install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
    );
  }

  if (options.requireSsmPlugin && !ssmPlugin) {
    throw new Error(
      'AWS Session Manager plugin is not installed. Install it from https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
    );
  }

  return { identity, awsCli, ssmPlugin };
}
