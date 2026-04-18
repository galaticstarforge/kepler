import type { DocumentStore } from '@keplerforge/shared';

export type PassRunStatus = 'success' | 'error' | 'timeout' | 'skipped';

export interface PassRunRecord {
  runId: string;
  traceId: string;
  repo: string;
  pass: string;
  status: PassRunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  dependsOn: string[];
  stats?: Record<string, unknown>;
  error?: string;
}

export interface PassRunHistoryStore {
  append(record: PassRunRecord): Promise<void>;
  list(repo: string, limit?: number): Promise<PassRunRecord[]>;
}

export class NoopPassRunHistoryStore implements PassRunHistoryStore {
  async append(): Promise<void> {}
  async list(): Promise<PassRunRecord[]> {
    return [];
  }
}

const PREFIX = '_meta/pass-runs';

function safeSegment(s: string): string {
  return s.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}

function recordPath(record: PassRunRecord): string {
  const repoSeg = safeSegment(record.repo);
  const passSeg = safeSegment(record.pass);
  const stamp = safeSegment(record.startedAt);
  return `${PREFIX}/${repoSeg}/${stamp}-${record.runId}-${passSeg}.json`;
}

export class DocumentStorePassRunHistoryStore implements PassRunHistoryStore {
  constructor(private readonly store: DocumentStore) {}

  async append(record: PassRunRecord): Promise<void> {
    const body = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
    await this.store.put(recordPath(record), body, {
      contentType: 'application/json',
      contentLength: body.byteLength,
      lastModified: new Date(record.endedAt),
      custom: {
        traceId: record.traceId,
        pass: record.pass,
        status: record.status,
      },
    });
  }

  async list(repo: string, limit = 100): Promise<PassRunRecord[]> {
    const records: PassRunRecord[] = [];
    const prefix = `${PREFIX}/${safeSegment(repo)}/`;
    for await (const head of this.store.list(prefix)) {
      const bytes = await this.store.get(head.path);
      if (!bytes) continue;
      try {
        const parsed = JSON.parse(bytes.content.toString('utf8')) as PassRunRecord;
        records.push(parsed);
      } catch {
        // Corrupt entry — ignore.
      }
    }
    records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return records.slice(0, limit);
  }
}
