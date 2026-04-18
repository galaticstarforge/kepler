import { createLogger, type Logger } from '../logger.js';

import type { SummarizationAgent, SummarizationAgentConfig } from './agent.js';

/**
 * Runs the summarization agent on a configurable interval.
 *
 * The schedule is expressed in minutes (not a full cron expression) for
 * simplicity. A value of 0 or undefined disables scheduled runs.
 */
export interface SummarizationSchedulerDeps {
  agent: SummarizationAgent;
  logger?: Logger;
}

export interface SummarizationSchedulerConfig {
  /** Minutes between scheduled full runs. 0 = disabled. */
  scheduleMinutes: number;
  agentConfig: SummarizationAgentConfig;
}

export class SummarizationScheduler {
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SummarizationSchedulerDeps) {
    this.log = deps.logger ?? createLogger('summarization-scheduler');
  }

  start(cfg: SummarizationSchedulerConfig): void {
    if (cfg.scheduleMinutes <= 0) {
      this.log.info('summarization scheduler disabled (scheduleMinutes=0)');
      return;
    }
    if (this.timer) {
      this.log.warn('summarization scheduler already running');
      return;
    }

    const intervalMs = cfg.scheduleMinutes * 60 * 1000;
    this.log.info('summarization scheduler started', {
      scheduleMinutes: cfg.scheduleMinutes,
      repo: cfg.agentConfig.repo,
    });

    this.timer = setInterval(() => {
      this.log.info('scheduled summarization run triggered');
      this.deps.agent.trigger(cfg.agentConfig);
    }, intervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info('summarization scheduler stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
