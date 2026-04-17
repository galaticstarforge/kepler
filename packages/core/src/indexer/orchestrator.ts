import { readFile } from 'node:fs/promises';

import type { BaseExtractorConfig, OrchestratorConfig } from '../config.js';
import type { GraphClient } from '../graph/graph-client.js';
import { createLogger, type Logger } from '../logger.js';
import type { GitRepoWatcher, RepoUpdateEvent } from '../repos/git-repo-watcher.js';

import { BehavioralAnalyzer } from './extractor/behavioral-analyzer.js';
import { GraphWriter } from './extractor/graph-writer.js';
import { JsExtractor } from './extractor/js-extractor.js';
import { FileDiscovery } from './file-discovery.js';

export interface OrchestratorDeps {
  watcher: GitRepoWatcher;
  graph: GraphClient;
  config: OrchestratorConfig;
  extractorConfig: BaseExtractorConfig;
  logger?: Logger;
}

export class Orchestrator {
  private readonly log: Logger;
  private readonly inFlight = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.logger ?? createLogger('orchestrator');
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.watcher.onRepoUpdated((event) => {
      this.handleRepoUpdate(event);
    });
    this.log.info('started');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.log.info('stopped');
  }

  private handleRepoUpdate(event: RepoUpdateEvent): void {
    const repoName = event.repo.name;

    if (this.inFlight.has(repoName)) {
      this.log.debug('indexing already in flight, skipping', { repo: repoName });
      return;
    }

    if (this.inFlight.size >= this.deps.config.maxConcurrentRepos) {
      this.log.warn('max concurrent repos reached, skipping', {
        repo: repoName,
        max: this.deps.config.maxConcurrentRepos,
      });
      return;
    }

    const task = this.indexRepo(event)
      .catch((error: unknown) => {
        this.log.error('indexing failed', { repo: repoName, error: String(error) });
      })
      .finally(() => {
        this.inFlight.delete(repoName);
      });

    this.inFlight.set(repoName, task);
  }

  private async indexRepo(event: RepoUpdateEvent): Promise<void> {
    const { repo, workingDir } = event;
    this.log.info('indexing started', {
      repo: repo.name,
      workingDir,
      previousSha: event.previousSha,
      currentSha: event.currentSha,
    });

    const discovery = new FileDiscovery({
      graph: this.deps.graph,
      logger: createLogger('file-discovery'),
    });

    const files = await discovery.discoverChangedFiles(
      repo.name,
      workingDir,
      this.deps.extractorConfig,
    );

    this.log.info('files to index', { repo: repo.name, count: files.length });

    if (files.length === 0) return;

    const extractor = new JsExtractor({ repo: repo.name });
    const behavioralAnalyzer = new BehavioralAnalyzer({ repo: repo.name });
    const writer = new GraphWriter({
      graph: this.deps.graph,
      logger: createLogger('graph-writer'),
    });

    let indexed = 0;
    let errors = 0;

    for (const file of files) {
      try {
        const content = await readFile(file.absolutePath, 'utf8');
        const result = extractor.extract(file.absolutePath, file.relativePath, content);
        // Stamp the hash from discovery (extractor leaves it blank)
        result.module.hash = file.hash;
        await writer.write(result);

        const behavioral = behavioralAnalyzer.analyze(file.relativePath, content, result.symbols);
        await writer.writeBehavioral(repo.name, file.relativePath, behavioral);

        indexed++;
      } catch (error) {
        errors++;
        this.log.warn('file indexing failed', {
          repo: repo.name,
          file: file.relativePath,
          error: String(error),
        });
      }
    }

    this.log.info('indexing complete', { repo: repo.name, indexed, errors });
  }
}
