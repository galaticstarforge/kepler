import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SendCommandCommand } from '@aws-sdk/client-ssm';
import { Command } from 'commander';

import { getS3Client, getLogsClient, getSSMClient } from '../lib/aws-clients.js';
import { readLocalState } from '../lib/config.js';
import { NotInitializedError } from '../lib/errors.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';

export const pluginCommand = new Command('plugin')
  .description('Manage plugins')
  .addCommand(
    new Command('upload')
      .description('Upload a plugin to the state bucket')
      .argument('<path>', 'Path to the plugin package directory')
      .action(async (pluginPath: string) => {
        try {
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();
          const deploymentName = state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No active deployment. Run `kepler deploy` first.');
            process.exit(1);
          }

          const absPath = path.resolve(pluginPath);
          const pkgPath = path.join(absPath, 'package.json');
          if (!existsSync(pkgPath)) {
            logger.error(`Not a valid Node package: ${absPath} (missing package.json)`);
            process.exit(1);
          }

          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            name: string;
            version: string;
          };
          const tarballName = `${pkg.name.replaceAll('/', '-').replace('@', '')}-${pkg.version}.tgz`;

          // Create tarball
          execSync('npm pack', { cwd: absPath, stdio: 'pipe' });
          const tarball = readFileSync(path.join(absPath, tarballName));

          const s3 = getS3Client();
          const key = `deployments/${deploymentName}/plugins/packages/${tarballName}`;
          await s3.send(
            new PutObjectCommand({
              Bucket: state.stateBucket,
              Key: key,
              Body: tarball,
              ContentType: 'application/gzip',
            }),
          );

          output(
            isJsonOutput()
              ? { status: 'uploaded', plugin: pkg.name, version: pkg.version, key }
              : `Plugin ${pkg.name}@${pkg.version} uploaded.`,
          );
        } catch (error) {
          handleError(error);
        }
      }),
  )
  .addCommand(
    new Command('enable')
      .description('Enable a plugin')
      .argument('<name>', 'Plugin name')
      .action(async (name: string) => {
        try {
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();
          const deploymentName = state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No active deployment.');
            process.exit(1);
          }

          const s3 = getS3Client();
          const key = `deployments/${deploymentName}/plugins/enabled.yaml`;

          let enabled: string[] = [];
          try {
            const existing = await s3.send(
              new GetObjectCommand({ Bucket: state.stateBucket, Key: key }),
            );
            const body = await existing.Body?.transformToString();
            if (body) {
              const YAML = await import('yaml');
              enabled = (YAML.parse(body) as { plugins: string[] })?.plugins || [];
            }
          } catch {
            // File doesn't exist yet
          }

          if (!enabled.includes(name)) {
            enabled.push(name);
          }

          const YAML = await import('yaml');
          await s3.send(
            new PutObjectCommand({
              Bucket: state.stateBucket,
              Key: key,
              Body: YAML.stringify({ plugins: enabled }),
              ContentType: 'text/yaml',
            }),
          );

          output(
            isJsonOutput()
              ? { status: 'enabled', plugin: name }
              : `Plugin "${name}" enabled.`,
          );

          // Restart kepler service on the instance to pick up the change
          await restartKeplerService(state, deploymentName);
        } catch (error) {
          handleError(error);
        }
      }),
  )
  .addCommand(
    new Command('disable')
      .description('Disable a plugin')
      .argument('<name>', 'Plugin name')
      .action(async (name: string) => {
        try {
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();
          const deploymentName = state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No active deployment.');
            process.exit(1);
          }

          const s3 = getS3Client();
          const key = `deployments/${deploymentName}/plugins/enabled.yaml`;

          let enabled: string[] = [];
          try {
            const existing = await s3.send(
              new GetObjectCommand({ Bucket: state.stateBucket, Key: key }),
            );
            const body = await existing.Body?.transformToString();
            if (body) {
              const YAML = await import('yaml');
              enabled = (YAML.parse(body) as { plugins: string[] })?.plugins || [];
            }
          } catch {
            // File doesn't exist yet
          }

          enabled = enabled.filter((p) => p !== name);

          const YAML = await import('yaml');
          await s3.send(
            new PutObjectCommand({
              Bucket: state.stateBucket,
              Key: key,
              Body: YAML.stringify({ plugins: enabled }),
              ContentType: 'text/yaml',
            }),
          );

          output(
            isJsonOutput()
              ? { status: 'disabled', plugin: name }
              : `Plugin "${name}" disabled.`,
          );

          // Restart kepler service on the instance to pick up the change
          await restartKeplerService(state, deploymentName);
        } catch (error) {
          handleError(error);
        }
      }),
  )
  .addCommand(
    new Command('list')
      .description('List plugins')
      .action(async () => {
        try {
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();
          const deploymentName = state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No active deployment.');
            process.exit(1);
          }

          const s3 = getS3Client();
          const key = `deployments/${deploymentName}/plugins/enabled.yaml`;

          let enabled: string[] = [];
          try {
            const existing = await s3.send(
              new GetObjectCommand({ Bucket: state.stateBucket, Key: key }),
            );
            const body = await existing.Body?.transformToString();
            if (body) {
              const YAML = await import('yaml');
              enabled = (YAML.parse(body) as { plugins: string[] })?.plugins || [];
            }
          } catch {
            // File doesn't exist yet
          }

          if (isJsonOutput()) {
            output({ plugins: enabled });
          } else if (enabled.length === 0) {
            logger.info('No plugins enabled.');
          } else {
            logger.info('Enabled plugins:');
            for (const p of enabled) {
              logger.info(`  - ${p}`);
            }
          }
        } catch (error) {
          handleError(error);
        }
      }),
  )
  .addCommand(
    new Command('logs')
      .description('Tail plugin logs')
      .argument('<name>', 'Plugin name')
      .option('--since <duration>', 'How far back to fetch logs (e.g. 1h, 30m)', '1h')
      .option('--limit <count>', 'Max number of log events', '100')
      .action(async (name: string, options: { since: string; limit: string }) => {
        try {
          const state = readLocalState();
          if (!state?.stateBucket) throw new NotInitializedError();
          const deploymentName = state.lastUsedDeployment;
          if (!deploymentName) {
            logger.error('No active deployment.');
            process.exit(1);
          }

          const logGroupName = `/kepler/${deploymentName}`;
          const sinceMs = parseDuration(options.since);
          const startTime = Date.now() - sinceMs;
          const limit = Math.min(Number.parseInt(options.limit, 10) || 100, 10_000);

          const logs = getLogsClient();
          const response = await logs.send(
            new FilterLogEventsCommand({
              logGroupName,
              filterPattern: `"${name}"`,
              startTime,
              limit,
            }),
          );

          const events = response.events || [];

          if (isJsonOutput()) {
            output({ plugin: name, logGroup: logGroupName, events });
          } else if (events.length === 0) {
            logger.info(`No log events found for plugin "${name}" in the last ${options.since}.`);
          } else {
            for (const event of events) {
              const ts = event.timestamp ? new Date(event.timestamp).toISOString() : '';
              process.stdout.write(`${ts}  ${event.message?.trimEnd() ?? ''}\n`);
            }
          }
        } catch (error) {
          handleError(error);
        }
      }),
  );

function parseDuration(input: string): number {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) return 3_600_000; // default 1h
  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2];
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return 3_600_000;
}

async function restartKeplerService(
  state: { stateBucket: string; region: string },
  deploymentName: string,
): Promise<void> {
  const { getStatus } = await import('@keplerforge/installer');
  const status = await getStatus(deploymentName, state.region);
  if (!status?.instanceId) {
    logger.warn('Could not determine instance ID — skipping service restart.');
    return;
  }

  try {
    const ssm = getSSMClient();
    await ssm.send(
      new SendCommandCommand({
        InstanceIds: [status.instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
          commands: ['sudo systemctl restart kepler.service'],
        },
      }),
    );
    logger.info('Restarting kepler service on instance...');
  } catch {
    logger.warn('Failed to restart kepler service. You may need to restart it manually.');
  }
}
