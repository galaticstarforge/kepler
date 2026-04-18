import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

import type { SourceAccessConfig } from '../config.js';
import { createLogger, type Logger } from '../logger.js';

import type { RepoEntry, ReposConfig } from './repos-config.js';

export interface RepoUpdateEvent {
  repo: RepoEntry;
  workingDir: string;
  previousSha: string | null;
  currentSha: string;
  at: Date;
}

export type RepoUpdateListener = (event: RepoUpdateEvent) => void | Promise<void>;

export interface GitRepoWatcherDeps {
  config: SourceAccessConfig;
  repos: ReposConfig;
  logger?: Logger;
}

export class GitRepoWatcher {
  private readonly config: SourceAccessConfig;
  private readonly repoList: RepoEntry[];
  private readonly log: Logger;
  private readonly listeners = new Set<RepoUpdateListener>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(deps: GitRepoWatcherDeps) {
    this.config = deps.config;
    this.repoList = deps.repos.repos;
    this.log = deps.logger ?? createLogger('git-repo-watcher');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await mkdir(this.config.cloneRoot, { recursive: true });

    this.log.info('starting', {
      cloneRoot: this.config.cloneRoot,
      fetchIntervalSeconds: this.config.fetchIntervalSeconds,
      repos: this.repoList.length,
    });

    await this.syncAll();

    const intervalMs = Math.max(1, this.config.fetchIntervalSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.syncAll();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  repos(): RepoEntry[] {
    return [...this.repoList];
  }

  onRepoUpdated(listener: RepoUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async syncAll(): Promise<void> {
    await Promise.all(this.repoList.map((repo) => this.runOnce(repo)));
  }

  private runOnce(repo: RepoEntry): Promise<void> {
    const existing = this.inFlight.get(repo.name);
    if (existing) return existing;

    const task = this.syncRepo(repo)
      .catch((error: unknown) => {
        this.log.error('sync failed', { repo: repo.name, error: String(error) });
      })
      .finally(() => {
        this.inFlight.delete(repo.name);
      });

    this.inFlight.set(repo.name, task);
    return task;
  }

  private async syncRepo(repo: RepoEntry): Promise<void> {
    const workingDir = path.join(this.config.cloneRoot, repo.name);
    const exists = await pathExists(workingDir);

    if (!exists) {
      await this.cloneRepo(repo, workingDir);
      const git = this.gitFor(workingDir);
      const currentRaw = await git.revparse(['HEAD']);
      const currentSha = currentRaw.trim();
      this.log.info('cloned', { repo: repo.name, sha: currentSha });
      await this.emit({ repo, workingDir, previousSha: null, currentSha, at: new Date() });
      return;
    }

    const git = this.gitFor(workingDir);
    const previousRaw = await git.revparse(['HEAD']);
    const previousSha = previousRaw.trim();
    await git.fetch('origin', repo.branch);
    await git.pull('origin', repo.branch, { '--ff-only': null });
    const currentRaw = await git.revparse(['HEAD']);
    const currentSha = currentRaw.trim();

    if (previousSha === currentSha) {
      this.log.debug('no change', { repo: repo.name, sha: currentSha });
      return;
    }

    this.log.info('updated', { repo: repo.name, previousSha, currentSha });
    await this.emit({ repo, workingDir, previousSha, currentSha, at: new Date() });
  }

  private async cloneRepo(repo: RepoEntry, workingDir: string): Promise<void> {
    const git = this.gitFor(this.config.cloneRoot);
    const args: string[] = ['--branch', repo.branch];
    if (repo.cloneDepth > 0) {
      args.push('--depth', String(repo.cloneDepth));
    }
    this.log.info('cloning', { repo: repo.name, url: repo.url, branch: repo.branch });
    await git.clone(repo.url, workingDir, args);
  }

  private gitFor(workingDir: string): SimpleGit {
    const opts: Partial<SimpleGitOptions> = {
      baseDir: workingDir,
      binary: 'git',
      maxConcurrentProcesses: 1,
      config: [],
      unsafe: { allowUnsafeSshCommand: true },
    };
    return simpleGit(opts).env(this.buildEnv());
  }

  private buildEnv(): NodeJS.ProcessEnv {
    // simple-git rejects inherited env vars like EDITOR / GIT_EDITOR / GIT_PAGER
    // unless explicitly opted in. Strip them from the inherited env before
    // adding our own SSH command.
    const STRIP = new Set([
      'EDITOR',
      'GIT_EDITOR',
      'GIT_SEQUENCE_EDITOR',
      'GIT_PAGER',
      'PAGER',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GIT_SSH',
      'GIT_SSH_COMMAND',
      'GIT_PROXY_COMMAND',
      'GIT_EXTERNAL_DIFF',
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!STRIP.has(k) && v !== undefined) env[k] = v;
    }
    env.GIT_SSH_COMMAND = this.sshCommand();
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
  }

  private sshCommand(): string {
    const knownHosts = path.join(this.config.cloneRoot, '.known_hosts');
    const opts = [
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'BatchMode=yes',
    ];
    if (this.config.sshKeyPath) {
      opts.unshift('-i', this.config.sshKeyPath);
    }
    return ['ssh', ...opts].join(' ');
  }

  private async emit(event: RepoUpdateEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.log.error('listener failed', { repo: event.repo.name, error: String(error) });
      }
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
