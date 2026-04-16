import { confirm, select, input } from '@inquirer/prompts';

import { isJsonOutput } from './logger.js';

export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  if (isJsonOutput()) {
    return defaultValue;
  }
  return confirm({ message, default: defaultValue });
}

export async function promptSelect<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T; description?: string }>,
): Promise<T> {
  if (isJsonOutput()) {
    throw new Error(`Interactive selection required but running in JSON mode: ${message}`);
  }
  return select({ message, choices });
}

export async function promptInput(message: string, defaultValue?: string): Promise<string> {
  if (isJsonOutput()) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Interactive input required but running in JSON mode: ${message}`);
  }
  return input({ message, default: defaultValue });
}
