import { randomUUID } from 'node:crypto';

import type { PassFailurePolicy, PassSettings } from '../config.js';
import type { GraphClient } from '../graph/graph-client.js';
import { createLogger, type Logger } from '../logger.js';

import {
  NoopPassRunHistoryStore,
  type PassRunHistoryStore,
  type PassRunRecord,
  type PassRunStatus,
} from './pass-run-history-store.js';

export interface PassContext {
  repo: string;
  workingDir: string;
  graph: GraphClient;
  /** Per-pass config bag from `orchestrator.passes[<name>].config`. */
  config: Record<string, unknown> | undefined;
  logger: Logger;
  traceId: string;
  /** Aborted when the per-pass timeout fires. Cooperative — passes should check it when practical. */
  signal: AbortSignal;
}

export interface PassStats {
  [key: string]: unknown;
}

export interface Pass {
  readonly name: string;
  runFor(ctx: PassContext): Promise<PassStats | void>;
}

export interface PassRegisterOptions {
  dependsOn?: string[];
  /** Overrides the orchestrator default. `0` or negative disables the timeout for this pass. */
  timeoutSeconds?: number;
}

interface Registration {
  pass: Pass;
  dependsOn: string[];
  timeoutSeconds?: number;
}

export interface PassRunnerConfig {
  passTimeoutSeconds: number;
  passFailurePolicy: PassFailurePolicy;
  passes: Record<string, PassSettings>;
}

export interface PassRunnerDeps {
  graph: GraphClient;
  config: PassRunnerConfig;
  historyStore?: PassRunHistoryStore;
  logger?: Logger;
}

export interface PassRunnerInput {
  repo: string;
  workingDir: string;
  traceId?: string;
}

/** Sentinel thrown by the timeout racer. Not re-exported — callers consume records. */
class PassTimeoutError extends Error {
  constructor(passName: string, seconds: number) {
    super(`pass ${passName} exceeded timeout of ${seconds}s`);
    this.name = 'PassTimeoutError';
  }
}

export class PassRunner {
  private readonly log: Logger;
  private readonly history: PassRunHistoryStore;
  private readonly registrations = new Map<string, Registration>();
  private readonly order: string[] = [];

  constructor(private readonly deps: PassRunnerDeps) {
    this.log = deps.logger ?? createLogger('pass-runner');
    this.history = deps.historyStore ?? new NoopPassRunHistoryStore();
  }

  register(pass: Pass, opts: PassRegisterOptions = {}): void {
    if (this.registrations.has(pass.name)) {
      throw new Error(`pass already registered: ${pass.name}`);
    }
    const reg: Registration = {
      pass,
      dependsOn: [...(opts.dependsOn ?? [])],
    };
    if (opts.timeoutSeconds !== undefined) reg.timeoutSeconds = opts.timeoutSeconds;
    this.registrations.set(pass.name, reg);
    this.order.push(pass.name);
  }

  /**
   * Executes every registered pass in dependency order. Disabled passes are
   * recorded as `skipped`; a skipped or failed pass transitively skips any
   * dependents when the failure policy is `abort`, or when the pass is
   * explicitly disabled.
   */
  async runAll(input: PassRunnerInput): Promise<PassRunRecord[]> {
    const plan = this.planExecution();
    const traceId = input.traceId ?? randomUUID();
    const runId = randomUUID();
    const settings = this.deps.config.passes;
    const policy = this.deps.config.passFailurePolicy;

    this.log.info('pass run starting', {
      runId,
      traceId,
      repo: input.repo,
      passes: plan,
      policy,
    });

    const records: PassRunRecord[] = [];
    const outcomeByPass = new Map<string, PassRunStatus>();

    for (const name of plan) {
      const reg = this.registrations.get(name)!;
      const passSettings = settings[name] ?? { enabled: true };

      const blockedBy = this.firstBlockingDep(reg.dependsOn, outcomeByPass);
      if (passSettings.enabled === false || blockedBy) {
        const reason = passSettings.enabled === false ? 'disabled' : `blocked by ${blockedBy}`;
        const record = buildSkipRecord({
          runId,
          traceId,
          repo: input.repo,
          pass: name,
          dependsOn: reg.dependsOn,
          reason,
        });
        records.push(record);
        outcomeByPass.set(name, 'skipped');
        await this.persist(record);
        this.log.info('pass skipped', { runId, traceId, repo: input.repo, pass: name, reason });
        continue;
      }

      const record = await this.executePass({
        runId,
        traceId,
        reg,
        input,
        passConfig: passSettings.config,
      });
      records.push(record);
      outcomeByPass.set(name, record.status);
      await this.persist(record);

      if (record.status !== 'success' && policy === 'abort') {
        this.log.warn('pass run aborting due to failure policy', {
          runId,
          traceId,
          repo: input.repo,
          pass: name,
          status: record.status,
        });
        // Mark remaining passes as skipped in the record set for transparency.
        for (const remaining of plan.slice(plan.indexOf(name) + 1)) {
          if (outcomeByPass.has(remaining)) continue;
          const rem = this.registrations.get(remaining)!;
          const skipRecord = buildSkipRecord({
            runId,
            traceId,
            repo: input.repo,
            pass: remaining,
            dependsOn: rem.dependsOn,
            reason: `aborted after ${name} ${record.status}`,
          });
          records.push(skipRecord);
          outcomeByPass.set(remaining, 'skipped');
          await this.persist(skipRecord);
        }
        break;
      }
    }

    this.log.info('pass run complete', {
      runId,
      traceId,
      repo: input.repo,
      total: records.length,
      success: records.filter((r) => r.status === 'success').length,
      error: records.filter((r) => r.status === 'error').length,
      timeout: records.filter((r) => r.status === 'timeout').length,
      skipped: records.filter((r) => r.status === 'skipped').length,
    });

    return records;
  }

  private async executePass(args: {
    runId: string;
    traceId: string;
    reg: Registration;
    input: PassRunnerInput;
    passConfig: Record<string, unknown> | undefined;
  }): Promise<PassRunRecord> {
    const { runId, traceId, reg, input, passConfig } = args;
    const passLogger = createLogger(`pass:${reg.pass.name}`);
    const timeoutSeconds = reg.timeoutSeconds ?? this.deps.config.passTimeoutSeconds;
    const controller = new AbortController();
    const startedAt = new Date();
    const start = startedAt.toISOString();

    passLogger.info('pass started', {
      runId,
      traceId,
      repo: input.repo,
      timeoutSeconds,
    });

    let status: PassRunStatus = 'success';
    let stats: Record<string, unknown> | undefined;
    let error: string | undefined;

    const ctx: PassContext = {
      repo: input.repo,
      workingDir: input.workingDir,
      graph: this.deps.graph,
      config: passConfig,
      logger: passLogger,
      traceId,
      signal: controller.signal,
    };

    try {
      const result = await this.raceTimeout(reg.pass, ctx, timeoutSeconds, controller);
      if (result && typeof result === 'object') stats = result as Record<string, unknown>;
    } catch (error_) {
      if (error_ instanceof PassTimeoutError) {
        status = 'timeout';
        error = error_.message;
      } else {
        status = 'error';
        error = error_ instanceof Error ? error_.message : String(error_);
      }
    } finally {
      controller.abort();
    }

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const record: PassRunRecord = {
      runId,
      traceId,
      repo: input.repo,
      pass: reg.pass.name,
      status,
      startedAt: start,
      endedAt: endedAt.toISOString(),
      durationMs,
      dependsOn: reg.dependsOn,
      ...(stats === undefined ? {} : { stats }),
      ...(error === undefined ? {} : { error }),
    };

    passLogger.info('pass finished', {
      runId,
      traceId,
      repo: input.repo,
      status,
      durationMs,
    });

    return record;
  }

  private raceTimeout(
    pass: Pass,
    ctx: PassContext,
    timeoutSeconds: number,
    controller: AbortController,
  ): Promise<PassStats | void> {
    const exec = pass.runFor(ctx);
    if (!timeoutSeconds || timeoutSeconds <= 0) return exec;
    return new Promise<PassStats | void>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new PassTimeoutError(pass.name, timeoutSeconds));
      }, timeoutSeconds * 1000);
      timer.unref?.();
      exec.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async persist(record: PassRunRecord): Promise<void> {
    try {
      await this.history.append(record);
    } catch (error) {
      this.log.warn('failed to persist pass run record', {
        runId: record.runId,
        traceId: record.traceId,
        repo: record.repo,
        pass: record.pass,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private firstBlockingDep(
    dependsOn: string[],
    outcomes: Map<string, PassRunStatus>,
  ): string | null {
    // A dependent always skips when its dep did not succeed — the pass contract
    // assumes the dep's side effects are in place. The `continue` policy lets
    // *independent* siblings keep running; it does not unblock dependents.
    for (const dep of dependsOn) {
      const outcome = outcomes.get(dep);
      if (!outcome) continue;
      if (outcome !== 'success') return dep;
    }
    return null;
  }

  /**
   * Topologically orders registrations. Preserves insertion order within a
   * dependency level so tests asserting sibling order are deterministic.
   * Throws on unknown deps or cycles.
   */
  private planExecution(): string[] {
    const remaining = new Set(this.order);
    const planned: string[] = [];
    const seen = new Set<string>();

    // Validate dependency names up front.
    for (const [name, reg] of this.registrations) {
      for (const dep of reg.dependsOn) {
        if (!this.registrations.has(dep)) {
          throw new Error(`pass ${name} depends on unknown pass ${dep}`);
        }
        if (dep === name) {
          throw new Error(`pass ${name} depends on itself`);
        }
      }
    }

    while (remaining.size > 0) {
      let progressed = false;
      for (const name of this.order) {
        if (!remaining.has(name)) continue;
        const reg = this.registrations.get(name)!;
        if (reg.dependsOn.every((d) => seen.has(d))) {
          planned.push(name);
          seen.add(name);
          remaining.delete(name);
          progressed = true;
        }
      }
      if (!progressed) {
        const cyclic = [...remaining].sort();
        throw new Error(`cycle detected among passes: ${cyclic.join(', ')}`);
      }
    }

    return planned;
  }
}

function buildSkipRecord(args: {
  runId: string;
  traceId: string;
  repo: string;
  pass: string;
  dependsOn: string[];
  reason: string;
}): PassRunRecord {
  const now = new Date().toISOString();
  return {
    runId: args.runId,
    traceId: args.traceId,
    repo: args.repo,
    pass: args.pass,
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    dependsOn: args.dependsOn,
    error: args.reason,
  };
}
