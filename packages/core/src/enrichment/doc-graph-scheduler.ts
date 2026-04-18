import { createLogger, type Logger } from '../logger.js';

import type { DocGraphReconciler, DocGraphRunOptions } from './doc-graph-reconciler.js';

export interface DocGraphSchedulerDeps {
  reconciler: DocGraphReconciler;
  logger?: Logger;
}

export interface DocGraphSchedulerConfig {
  /** Minutes between scheduled runs. 0 = disabled. */
  scheduleMinutes: number;
  runOptions?: DocGraphRunOptions;
}

/**
 * Runs the doc-graph reconciler on a configurable interval.
 * Pattern mirrors SummarizationScheduler for consistency.
 */
export class DocGraphScheduler {
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DocGraphSchedulerDeps) {
    this.log = deps.logger ?? createLogger('doc-graph-scheduler');
  }

  start(cfg: DocGraphSchedulerConfig): void {
    if (cfg.scheduleMinutes <= 0) {
      this.log.info('doc-graph scheduler disabled (scheduleMinutes=0)');
      return;
    }
    if (this.timer) {
      this.log.warn('doc-graph scheduler already running');
      return;
    }

    const intervalMs = cfg.scheduleMinutes * 60 * 1000;
    this.log.info('doc-graph scheduler started', { scheduleMinutes: cfg.scheduleMinutes });

    this.timer = setInterval(() => {
      this.log.info('scheduled doc-graph reconciler run triggered');
      void this.deps.reconciler.start(cfg.runOptions ?? {}).catch((error: unknown) => {
        this.log.error('scheduled reconciler run failed to start', { error: String(error) });
      });
    }, intervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info('doc-graph scheduler stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
