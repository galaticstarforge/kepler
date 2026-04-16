import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_REGION = 'us-east-1';
const CONFIG_DIR = path.join(homedir(), '.config', 'kepler');
const STATE_FILE = path.join(CONFIG_DIR, 'state.yaml');

export function getRegion(): string {
  return process.env['KEPLER_REGION'] || DEFAULT_REGION;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getStateFilePath(): string {
  return STATE_FILE;
}
