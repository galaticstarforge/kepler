import { simpleGit, type SimpleGit } from 'simple-git';

import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';
import type { Pass, PassContext, PassStats } from '../pass-runner.js';

export interface GitVolatilityDeps {
  graph: GraphClient;
  logger?: Logger;
}

export interface GitVolatilityConfig {
  repo: string;
  workingDir: string;
  /** Days of history to scan for changeFrequency rolling window. Default 90. */
  frequencyWindowDays?: number;
  /** Months of history to scan for authorCount. Default 12. */
  authorWindowMonths?: number;
  /** Clock override for testing. Default: `() => new Date()`. */
  now?: () => Date;
}

export interface FileVolatility {
  repo: string;
  filePath: string;
  /** Changes per 30-day window over the configured frequency window. */
  changeFrequency: number;
  /** Distinct author emails over the configured author window. */
  authorCount: number;
  /** ISO-8601 timestamp of the most recent commit touching this file. */
  lastModified: string | null;
  /** Days since the file's first commit. */
  gitAge: number;
}

export interface GitVolatilityStats {
  filesScanned: number;
  symbolsUpdated: number;
}

interface LogEntry {
  isoDate: string;
  email: string;
}

const FORMAT = '%aI%x09%ae';

/**
 * Mines `git log` to produce file-level volatility signals and writes them
 * onto the symbols contained in those files. Granularity is file-level, not
 * symbol-level — see docs/graph/semantic-enrichment.md#git-derived-volatility-signals.
 */
export class GitVolatilityPass implements Pass {
  readonly name = 'git-volatility';
  private readonly log: Logger;

  constructor(private readonly deps: GitVolatilityDeps) {
    this.log = deps.logger ?? createLogger('git-volatility');
  }

  async runFor(ctx: PassContext): Promise<PassStats | void> {
    const cfg = (ctx.config ?? {}) as {
      frequencyWindowDays?: number;
      authorWindowMonths?: number;
    };
    const passConfig: GitVolatilityConfig = {
      repo: ctx.repo,
      workingDir: ctx.workingDir,
      ...(cfg.frequencyWindowDays === undefined
        ? {}
        : { frequencyWindowDays: cfg.frequencyWindowDays }),
      ...(cfg.authorWindowMonths === undefined
        ? {}
        : { authorWindowMonths: cfg.authorWindowMonths }),
    };
    const stats = await this.run(passConfig);
    return stats as unknown as PassStats;
  }

  async run(config: GitVolatilityConfig): Promise<GitVolatilityStats> {
    const { repo, workingDir } = config;
    const frequencyWindowDays = config.frequencyWindowDays ?? 90;
    const authorWindowMonths = config.authorWindowMonths ?? 12;
    const now = config.now ?? (() => new Date());

    this.log.info('git volatility pass started', { repo });

    const files = await this.deps.graph.runRead(
      `MATCH (m:Module {repo: $repo}) RETURN m.path AS filePath`,
      { repo },
      (r) => r.get('filePath') as string,
    );

    const git = simpleGit({ baseDir: workingDir });
    const volatilities = await this.collectFileVolatility(
      git,
      repo,
      files,
      frequencyWindowDays,
      authorWindowMonths,
      now(),
    );

    const symbolsUpdated = await this.writeVolatilityToSymbols(volatilities);
    const stats: GitVolatilityStats = { filesScanned: volatilities.length, symbolsUpdated };
    this.log.info('git volatility pass complete', { repo, ...stats });
    return stats;
  }

  async collectFileVolatility(
    git: SimpleGit,
    repo: string,
    files: string[],
    frequencyWindowDays: number,
    authorWindowMonths: number,
    now: Date,
  ): Promise<FileVolatility[]> {
    const freqCutoff = daysAgo(now, frequencyWindowDays);
    const authorCutoff = monthsAgo(now, authorWindowMonths);

    const results: FileVolatility[] = [];
    for (const filePath of files) {
      try {
        const entries = await readLog(git, filePath);
        if (entries.length === 0) continue;

        const recent = entries.filter((e) => new Date(e.isoDate) >= freqCutoff);
        const changeFrequency = (recent.length / frequencyWindowDays) * 30;

        const recentAuthors = new Set(
          entries
            .filter((e) => new Date(e.isoDate) >= authorCutoff)
            .map((e) => e.email.toLowerCase()),
        );

        const lastModified = entries[0]?.isoDate ?? null;
        const firstCommit = entries.at(-1)?.isoDate;
        const gitAge = firstCommit
          ? Math.max(0, Math.floor((now.getTime() - new Date(firstCommit).getTime()) / 86_400_000))
          : 0;

        results.push({
          repo,
          filePath,
          changeFrequency: Number(changeFrequency.toFixed(3)),
          authorCount: recentAuthors.size,
          lastModified,
          gitAge,
        });
      } catch (error) {
        this.log.debug('git log failed for file', { filePath, error: String(error) });
      }
    }
    return results;
  }

  async writeVolatilityToSymbols(rows: FileVolatility[]): Promise<number> {
    if (rows.length === 0) return 0;
    const results = await this.deps.graph.runWrite(
      `UNWIND $rows AS row
       MATCH (m:Module {repo: row.repo, path: row.filePath})-[:CONTAINS]->(s:Symbol)
       SET s.changeFrequency = row.changeFrequency,
           s.authorCount     = row.authorCount,
           s.lastModified    = row.lastModified,
           s.gitAge          = row.gitAge
       RETURN count(s) AS updated`,
      { rows },
      (r) => Number(r.get('updated')),
    );
    return results[0] ?? 0;
  }
}

async function readLog(git: SimpleGit, filePath: string): Promise<LogEntry[]> {
  const output: string = await git.raw([
    'log',
    '--follow',
    `--format=${FORMAT}`,
    '--',
    filePath,
  ]);
  return output
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .map((line: string): LogEntry => {
      const [isoDate, email] = line.split('\t');
      return { isoDate: isoDate ?? '', email: email ?? '' };
    })
    .filter((e: LogEntry) => e.isoDate && e.email);
}

function daysAgo(from: Date, days: number): Date {
  return new Date(from.getTime() - days * 86_400_000);
}

function monthsAgo(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() - months);
  return d;
}
