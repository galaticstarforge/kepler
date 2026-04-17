import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

export interface RepoEntry {
  name: string;
  url: string;
  branch: string;
  cloneDepth: number;
  ignorePatterns: string[];
}

export interface ReposDefaults {
  branch: string;
  cloneDepth: number;
  ignorePatterns: string[];
}

export interface ReposConfig {
  defaults: ReposDefaults;
  repos: RepoEntry[];
}

interface RawRepo {
  name?: unknown;
  url?: unknown;
  branch?: unknown;
  cloneDepth?: unknown;
  ignorePatterns?: unknown;
}

interface RawDefaults {
  branch?: unknown;
  cloneDepth?: unknown;
  ignorePatterns?: unknown;
}

const DEFAULT_DEFAULTS: ReposDefaults = {
  branch: 'main',
  cloneDepth: 0,
  ignorePatterns: [],
};

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const SSH_URL_RE = /^(git@[^:]+:|ssh:\/\/)/;

export class ReposConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReposConfigError';
  }
}

export function loadReposConfig(path?: string): ReposConfig | null {
  const reposPath = path ?? process.env['KEPLER_REPOS_PATH'] ?? '/etc/project/repos.yaml';

  let contents: string;
  try {
    contents = readFileSync(reposPath, 'utf8');
  } catch {
    return null;
  }

  const raw = parseYaml(contents) as Record<string, unknown> | null;
  if (!raw) {
    return { defaults: { ...DEFAULT_DEFAULTS }, repos: [] };
  }

  const defaults = mergeDefaults(raw['defaults'] as RawDefaults | undefined);
  const rawRepos = raw['repos'];
  if (rawRepos !== undefined && !Array.isArray(rawRepos)) {
    throw new ReposConfigError('repos.yaml: `repos` must be a list');
  }

  const seen = new Set<string>();
  const repos: RepoEntry[] = [];
  for (const entry of (rawRepos as RawRepo[] | undefined) ?? []) {
    const repo = normalizeRepo(entry, defaults);
    if (seen.has(repo.name)) {
      throw new ReposConfigError(`repos.yaml: duplicate repo name "${repo.name}"`);
    }
    seen.add(repo.name);
    repos.push(repo);
  }

  return { defaults, repos };
}

function mergeDefaults(raw: RawDefaults | undefined): ReposDefaults {
  if (!raw) return { ...DEFAULT_DEFAULTS };
  return {
    branch: typeof raw.branch === 'string' ? raw.branch : DEFAULT_DEFAULTS.branch,
    cloneDepth:
      typeof raw.cloneDepth === 'number' && Number.isInteger(raw.cloneDepth) && raw.cloneDepth >= 0
        ? raw.cloneDepth
        : DEFAULT_DEFAULTS.cloneDepth,
    ignorePatterns: Array.isArray(raw.ignorePatterns)
      ? raw.ignorePatterns.filter((s): s is string => typeof s === 'string')
      : [...DEFAULT_DEFAULTS.ignorePatterns],
  };
}

function normalizeRepo(raw: RawRepo, defaults: ReposDefaults): RepoEntry {
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new ReposConfigError('repos.yaml: every repo must have a non-empty `name`');
  }
  if (!NAME_RE.test(raw.name) || raw.name === '.' || raw.name === '..') {
    throw new ReposConfigError(
      `repos.yaml: repo name "${raw.name}" must match ${NAME_RE.source} and not be . or ..`,
    );
  }
  if (typeof raw.url !== 'string' || raw.url.length === 0) {
    throw new ReposConfigError(`repos.yaml: repo "${raw.name}" must have a non-empty \`url\``);
  }
  if (!SSH_URL_RE.test(raw.url)) {
    throw new ReposConfigError(
      `repos.yaml: repo "${raw.name}" url must be SSH form (git@host:org/repo.git or ssh://...), got: ${raw.url}`,
    );
  }

  const branch = typeof raw.branch === 'string' && raw.branch.length > 0 ? raw.branch : defaults.branch;
  const cloneDepth =
    typeof raw.cloneDepth === 'number' && Number.isInteger(raw.cloneDepth) && raw.cloneDepth >= 0
      ? raw.cloneDepth
      : defaults.cloneDepth;
  const ignorePatterns = Array.isArray(raw.ignorePatterns)
    ? raw.ignorePatterns.filter((s): s is string => typeof s === 'string')
    : [...defaults.ignorePatterns];

  return { name: raw.name, url: raw.url, branch, cloneDepth, ignorePatterns };
}
