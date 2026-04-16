import { consola } from 'consola';

export const logger = consola.withTag('kepler');

let _jsonOutput = false;
let _yesMode = false;

export function isJsonOutput(): boolean {
  return _jsonOutput;
}

export function isYesMode(): boolean {
  return _yesMode;
}

export function setYesMode(enabled: boolean): void {
  _yesMode = enabled;
}

export function setJsonOutput(enabled: boolean): void {
  _jsonOutput = enabled;
  if (enabled) {
    consola.setReporters([
      {
        log(logObj) {
          process.stdout.write(JSON.stringify(logObj) + '\n');
        },
      },
    ]);
  }
}

export function output(data: unknown): void {
  if (_jsonOutput) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else if (typeof data === 'string') {
    logger.info(data);
  } else {
    logger.info(JSON.stringify(data, null, 2));
  }
}

export function handleError(error: unknown): never {
  if (_jsonOutput) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = (error as { hint?: string }).hint;
    process.stdout.write(JSON.stringify({ error: message, hint }) + '\n');
  } else if (error instanceof Error && 'format' in error && typeof (error as { format: unknown }).format === 'function') {
    logger.error((error as { format(): string }).format());
  } else if (error instanceof Error) {
    logger.error(error.message);
  } else {
    logger.error(String(error));
  }
  const exitCode = (error as { exitCode?: number }).exitCode ?? 1;
  process.exit(exitCode);
}
