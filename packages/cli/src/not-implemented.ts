import chalk from 'chalk';

export function notImplemented(): void {
  console.log(chalk.yellow('not yet implemented'));
  process.exit(1);
}
