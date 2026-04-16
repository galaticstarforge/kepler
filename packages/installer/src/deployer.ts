import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import type { DeploymentConfig, DeploymentOutputs } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getStackName(deploymentName: string): string {
  return `kepler-${deploymentName}`;
}

async function findCdkBin(): Promise<string> {
  // Look for CDK binary in node_modules
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '.bin', 'cdk'),
    path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'cdk'),
    path.join(__dirname, '..', 'node_modules', 'aws-cdk', 'bin', 'cdk'),
  ];

  for (const candidate of candidates) {
    // On Windows, check for .cmd variant
    const cmdVariant = candidate + '.cmd';
    if (existsSync(cmdVariant)) return cmdVariant;
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'Could not find CDK binary. Ensure aws-cdk is installed as a dependency.',
  );
}

async function runCdk(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    onProgress?: (msg: string) => void;
  },
): Promise<string> {
  const { execa } = await import('execa');
  const cdkBin = await findCdkBin();

  const result = await execa(cdkBin, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
  });

  if (result.stdout && options.onProgress) {
    for (const line of result.stdout.split('\n')) {
      if (line.trim()) options.onProgress(line);
    }
  }

  if (result.exitCode !== 0) {
    const errorMsg = result.stderr || result.stdout || 'CDK command failed';
    throw new Error(`CDK failed (exit ${result.exitCode}): ${errorMsg}`);
  }

  return result.stdout;
}

function prepareCdkApp(config: DeploymentConfig): string {
  const app = createApp(config);
  const assembly = app.synth();
  return assembly.directory;
}

export async function deploy(
  config: DeploymentConfig,
  onProgress: (msg: string) => void,
): Promise<DeploymentOutputs> {
  const stackName = getStackName(config.deploymentName);
  const assemblyDir = prepareCdkApp(config);
  const outputsPath = path.join(assemblyDir, 'outputs.json');

  try {
    // Try bootstrap first (idempotent if already done)
    onProgress('Ensuring CDK bootstrap...');
    try {
      await runCdk(
        ['bootstrap', '--require-approval', 'never', '--app', assemblyDir],
        {
          cwd: assemblyDir,
          env: { CDK_DEFAULT_REGION: config.region },
          onProgress,
        },
      );
    } catch {
      onProgress('CDK bootstrap skipped or already done.');
    }

    // Deploy
    onProgress('Deploying stack...');
    await runCdk(
      ['deploy', '--require-approval', 'never', '--app', assemblyDir, '--outputs-file', outputsPath],
      {
        cwd: assemblyDir,
        env: { CDK_DEFAULT_REGION: config.region },
        onProgress,
      },
    );

    // Read outputs
    const { readFile } = await import('node:fs/promises');
    let outputs: DeploymentOutputs;
    try {
      const outputsRaw = await readFile(outputsPath, 'utf8');
      const parsed = JSON.parse(outputsRaw) as Record<string, Record<string, string>>;
      const stackOutputs = parsed[stackName] || {};

      outputs = {
        stackName,
        instanceId: stackOutputs['InstanceId'] || '',
        vpcId: stackOutputs['VpcId'] || '',
        docsBucketName: stackOutputs['DocsBucketName'] || '',
        logGroupName: stackOutputs['LogGroupName'] || '',
        region: stackOutputs['Region'] || config.region,
        deploymentName: stackOutputs['DeploymentName'] || config.deploymentName,
        status: 'CREATE_COMPLETE',
      };
    } catch {
      // If outputs file doesn't exist, construct from config
      outputs = {
        stackName,
        instanceId: '',
        vpcId: '',
        docsBucketName: '',
        logGroupName: `/kepler/${config.deploymentName}`,
        region: config.region,
        deploymentName: config.deploymentName,
        status: 'CREATE_COMPLETE',
      };
    }

    return outputs;
  } finally {
    // Clean up synth output
    await rm(assemblyDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function diff(
  config: DeploymentConfig,
  onProgress: (msg: string) => void,
): Promise<string> {
  const assemblyDir = prepareCdkApp(config);

  try {
    onProgress('Computing diff...');
    const output = await runCdk(
      ['diff', '--app', assemblyDir],
      {
        cwd: assemblyDir,
        env: { CDK_DEFAULT_REGION: config.region },
        onProgress,
      },
    );
    return output;
  } catch (error: unknown) {
    // cdk diff exits with code 1 when there are differences — that's expected
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('exit 1')) {
      // Extract the diff output from the error message
      const match = message.match(/CDK failed \(exit 1\): ([\s\S]*)/);
      return match?.[1]?.trim() || 'Changes detected (diff output unavailable).';
    }
    throw error;
  } finally {
    await rm(assemblyDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function destroy(
  deploymentName: string,
  region: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  const dummyConfig: DeploymentConfig = {
    deploymentName,
    region,
    stateBucketName: '',
    instanceTier: 'small',
    vpcStrategy: 'create',
    keplerVersion: '0.0.1',
  };

  const assemblyDir = prepareCdkApp(dummyConfig);

  try {
    onProgress('Destroying stack...');
    await runCdk(
      ['destroy', '--force', '--app', assemblyDir],
      {
        cwd: assemblyDir,
        env: { CDK_DEFAULT_REGION: region },
        onProgress,
      },
    );
    onProgress('Stack destroyed successfully.');
  } finally {
    await rm(assemblyDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getStatus(
  deploymentName: string,
  region: string,
): Promise<DeploymentOutputs | null> {
  // Use CloudFormation SDK directly for status checks
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    '@aws-sdk/client-cloudformation'
  );

  const cfn = new CloudFormationClient({ region });
  const stackName = getStackName(deploymentName);

  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );

    const stack = response.Stacks?.[0];
    if (!stack) return null;

    const outputs: Record<string, string> = {};
    for (const output of stack.Outputs || []) {
      if (output.OutputKey && output.OutputValue) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }

    return {
      stackName,
      instanceId: outputs['InstanceId'] || '',
      vpcId: outputs['VpcId'] || '',
      docsBucketName: outputs['DocsBucketName'] || '',
      logGroupName: outputs['LogGroupName'] || '',
      region: outputs['Region'] || region,
      deploymentName: outputs['DeploymentName'] || deploymentName,
      status: stack.StackStatus || 'UNKNOWN',
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('does not exist')) {
      return null;
    }
    throw error;
  }
}
