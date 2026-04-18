import type { DocumentStore } from '@keplerforge/shared';

import type { Logger } from '../logger.js';

export interface RunLogEntry {
  ts: string;
  tool: string;
  input: unknown;
  output: unknown;
}

const RUNS_PREFIX = 'summarization/_runs';

/**
 * Buffers tool-call log entries in memory and flushes them to a single JSONL
 * file in the document store (`summarization/_runs/<runId>.jsonl`) on demand
 * or when the buffer reaches a threshold. Each line is a JSON-serialised
 * `RunLogEntry`.
 */
export class RunLogger {
  private readonly buffer: string[] = [];
  private flushing = false;

  constructor(
    private readonly store: DocumentStore,
    public readonly runId: string,
    private readonly logger?: Logger,
  ) {}

  logCall(tool: string, input: unknown, output: unknown): void {
    const entry: RunLogEntry = {
      ts: new Date().toISOString(),
      tool,
      input,
      output,
    };
    this.buffer.push(JSON.stringify(entry));
    if (this.buffer.length >= 20) {
      this.flush().catch((error) => {
        this.logger?.warn('run-logger background flush failed', {
          runId: this.runId,
          error: String(error),
        });
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const lines = this.buffer.splice(0);
    this.flushing = false;

    try {
      const docPath = `${RUNS_PREFIX}/${this.runId}.jsonl`;
      const existing = await this.store.get(docPath);
      const current = existing ? existing.content.toString('utf8') : '';
      const appended = current + lines.join('\n') + '\n';
      const buf = Buffer.from(appended, 'utf8');
      await this.store.put(docPath, buf, {
        contentType: 'application/x-ndjson',
        contentLength: buf.byteLength,
        lastModified: new Date(),
        custom: { runId: this.runId },
      });
    } catch (error) {
      this.logger?.warn('run-logger flush failed', {
        runId: this.runId,
        error: String(error),
      });
    }
  }
}
