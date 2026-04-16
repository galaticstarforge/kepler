import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

const DEFAULT_REGION = 'us-east-1';

let _regionOverride: string | undefined;

export function setRegionOverride(region: string): void {
  _regionOverride = region;
}

export interface LocalState {
  stateBucket: string;
  region: string;
  lastUsedDeployment?: string;
}

function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env['APPDATA'] || path.join(homedir(), 'AppData', 'Roaming'), 'kepler');
  }
  return path.join(homedir(), '.config', 'kepler');
}

function getStateFilePath(): string {
  return path.join(getConfigDir(), 'state.yaml');
}

export function getRegion(): string {
  if (_regionOverride) return _regionOverride;

  const envRegion = process.env['KEPLER_REGION'];
  if (envRegion) return envRegion;

  const state = readLocalState();
  if (state?.region) return state.region;

  return DEFAULT_REGION;
}

export function readLocalState(): LocalState | null {
  const stateFile = getStateFilePath();
  if (!existsSync(stateFile)) return null;

  try {
    const content = readFileSync(stateFile, 'utf8');
    return YAML.parse(content) as LocalState;
  } catch {
    return null;
  }
}

export function writeLocalState(state: LocalState): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getStateFilePath(), YAML.stringify(state), 'utf8');
}

export function updateLocalState(updates: Partial<LocalState>): void {
  const current = readLocalState() || { stateBucket: '', region: DEFAULT_REGION };
  writeLocalState({ ...current, ...updates });
}

export { DEFAULT_REGION, getConfigDir, getStateFilePath };
