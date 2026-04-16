import { consola } from 'consola';

export const logger = consola.withTag('kepler');

export function setJsonOutput(enabled: boolean): void {
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
