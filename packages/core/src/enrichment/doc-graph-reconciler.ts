import { createHash, randomUUID } from 'node:crypto';

import type {
  DocGraphRunRecord,
  DocGraphRunStats,
  DocumentStore,
  ReferenceChannel,
  SymbolReference,
  UnresolvedReference,
} from '@keplerforge/shared';
import {
  CONCEPTS_PREFIX,
  DOC_GRAPH_INIT_KEY,
  DOC_GRAPH_RUNS_PREFIX,
} from '@keplerforge/shared';

import type { DocGraphCronConfig } from '../config.js';
import { parseFrontmatter } from '../docs/frontmatter-parser.js';
import type { GraphClient } from '../graph/graph-client.js';
import { createLogger, type Logger } from '../logger.js';

const log = createLogger('doc-graph-reconciler');

// ─── Internal types ───────────────────────────────────────────────────────────

interface ExtractedReference {
  name: string;
  channel: ReferenceChannel;
  repo?: string;
  filePath?: string;
  rawText: string;
}

interface ResolvedReference {
  original: ExtractedReference;
  entityType: 'symbol' | 'module';
  repo: string;
  filePath: string;
  symbolName?: string;
  confidence: 'exact' | 'fuzzy';
}

// Common English words and code keywords to filter from inline-code extraction.
const IDENTIFIER_STOPLIST = new Set([
  'null', 'undefined', 'true', 'false', 'new', 'return', 'const', 'let', 'var',
  'class', 'interface', 'type', 'enum', 'function', 'async', 'await', 'import',
  'export', 'default', 'from', 'this', 'super', 'extends', 'implements',
  'string', 'number', 'boolean', 'object', 'array', 'promise', 'error',
  'console', 'process', 'module', 'require', 'exports',
]);

// Prefixes to skip during document scanning.
const SKIP_PREFIXES = [CONCEPTS_PREFIX, DOC_GRAPH_RUNS_PREFIX, 'doc-graph-runs/'];

// Doc hierarchy to materialise on first run.
const DOC_HIERARCHY_DIRS = [
  '_meta/',
  '_meta/templates/',
  'platform/',
  'domains/',
  'services/',
  'apps/',
  'operations/',
  '.claude/sessions/',
  '.claude/proposals/',
  '.claude/scratchpad/',
];

const RELATED_CODE_BEGIN = '<!-- enrichment:related-code:begin -->';
const RELATED_CODE_END = '<!-- enrichment:related-code:end -->';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DocGraphReconcilerDeps {
  store: DocumentStore;
  graph: GraphClient;
  config: DocGraphCronConfig;
  logger?: Logger;
}

export interface DocGraphRunOptions {
  /** Restrict processing to documents whose path starts with this prefix. */
  pathPrefix?: string;
}

// ─── Reconciler ───────────────────────────────────────────────────────────────

export class DocGraphReconciler {
  private readonly log: Logger;

  constructor(private readonly deps: DocGraphReconcilerDeps) {
    this.log = deps.logger ?? log;
  }

  /**
   * Starts an asynchronous reconciliation run. Returns immediately with a
   * run record; work proceeds in the background.
   */
  async start(opts: DocGraphRunOptions = {}): Promise<DocGraphRunRecord> {
    const runId = randomUUID();
    const record: DocGraphRunRecord = {
      runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      stats: emptyStats(),
      unresolvedReferences: [],
    };
    await this.saveRunRecord(record);

    void this.run(record, opts).catch((error: unknown) => {
      this.log.error('unhandled reconciler failure', { runId, error: String(error) });
    });

    return record;
  }

  async getRunRecord(runId: string): Promise<DocGraphRunRecord | null> {
    const bytes = await this.deps.store.get(runRecordPath(runId));
    if (!bytes) return null;
    return JSON.parse(bytes.content.toString('utf8')) as DocGraphRunRecord;
  }

  /** Returns the unresolved references from the most recent completed run. */
  async latestUnresolved(): Promise<UnresolvedReference[]> {
    const runs: Array<{ runId: string; startedAt: string }> = [];
    for await (const head of this.deps.store.list(DOC_GRAPH_RUNS_PREFIX)) {
      if (!head.path.endsWith('.json')) continue;
      const bytes = await this.deps.store.get(head.path);
      if (!bytes) continue;
      try {
        const rec = JSON.parse(bytes.content.toString('utf8')) as DocGraphRunRecord;
        if (rec.status === 'completed') runs.push({ runId: rec.runId, startedAt: rec.startedAt });
      } catch {
        // ignore malformed records
      }
    }
    if (runs.length === 0) return [];
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const latest = await this.getRunRecord(runs[0]!.runId);
    return latest?.unresolvedReferences ?? [];
  }

  // ─── Core run ───────────────────────────────────────────────────────────────

  private async run(record: DocGraphRunRecord, opts: DocGraphRunOptions): Promise<void> {
    const started = Date.now();
    const { stats, unresolvedReferences } = record;

    try {
      await this.materializeDocHierarchy();

      const prefix = opts.pathPrefix ?? '';
      for await (const head of this.deps.store.list(prefix)) {
        if (!head.path.endsWith('.md')) continue;
        if (SKIP_PREFIXES.some((p) => head.path.startsWith(p))) continue;

        const bytes = await this.deps.store.get(head.path);
        if (!bytes) continue;
        const content = bytes.content.toString('utf8');
        const currentHash = computeHash(content);

        const storedHash = await this.getDocumentHash(head.path);
        if (storedHash === currentHash) {
          stats.docsSkipped++;
          continue;
        }

        stats.docsScanned++;
        try {
          const result = await this.processDocument(head.path, content, currentHash);
          stats.referencesFound += result.referencesFound;
          stats.referencesResolved += result.referencesResolved;
          stats.referencesUnresolved += result.referencesUnresolved;
          stats.edgesWritten += result.edgesWritten;
          if (result.docUpdated) stats.docsUpdated++;
          unresolvedReferences.push(...result.unresolved);
        } catch (error) {
          stats.errors.push(`process ${head.path}: ${String(error)}`);
        }
      }

      record.status = 'completed';
    } catch (error) {
      this.log.error('run failed', { runId: record.runId, error: String(error) });
      record.status = 'failed';
      record.error = String(error);
    } finally {
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.now() - started;
      await this.saveRunRecord(record);
      this.log.info('doc-graph reconciler run finished', {
        runId: record.runId,
        status: record.status,
        docsScanned: stats.docsScanned,
        docsSkipped: stats.docsSkipped,
        edgesWritten: stats.edgesWritten,
        unresolved: unresolvedReferences.length,
      });
    }
  }

  // ─── Per-document processing ─────────────────────────────────────────────

  private async processDocument(
    docPath: string,
    content: string,
    hash: string,
  ): Promise<{
    referencesFound: number;
    referencesResolved: number;
    referencesUnresolved: number;
    edgesWritten: number;
    docUpdated: boolean;
    unresolved: UnresolvedReference[];
  }> {
    const parsed = parseFrontmatter(content);
    const fm = parsed.data;
    const body = parsed.body;

    const extracted = [
      ...this.extractFromFrontmatter(fm.symbols ?? []),
      ...this.extractFromInlineCode(body),
      ...this.extractFromFencedImports(body),
      ...this.extractFromGraphLinks(body),
    ];

    const referencesFound = extracted.length;
    const resolved: ResolvedReference[] = [];
    const unresolved: UnresolvedReference[] = [];

    for (const ref of extracted) {
      const result = await this.resolveReference(ref, fm);
      if (result) {
        resolved.push(result);
      } else {
        unresolved.push({
          docPath,
          candidateName: ref.name,
          channel: ref.channel,
          reason: 'no graph match found',
        });
      }
    }

    // Write DOCUMENTED_BY edges (from frontmatter symbols:)
    const frontmatterRefs = (fm.symbols ?? []) as SymbolReference[];
    const documentedByCount = await this.writeDocumentedByEdges(docPath, frontmatterRefs);

    // Write REFERENCES edges (all resolved prose references)
    const referencesCount = await this.writeReferencesEdges(docPath, resolved);

    const edgesWritten = documentedByCount + referencesCount;

    // Optionally update the "Related Code" section.
    let docUpdated = false;
    if (this.deps.config.updateRelatedCodeSections && resolved.length > 0) {
      docUpdated = await this.updateRelatedCodeSection(docPath, resolved, content);
    }

    // Store the hash so re-runs skip unchanged docs.
    await this.setDocumentHash(docPath, hash);

    return {
      referencesFound,
      referencesResolved: resolved.length,
      referencesUnresolved: unresolved.length,
      edgesWritten,
      docUpdated,
      unresolved,
    };
  }

  // ─── Reference extraction ────────────────────────────────────────────────

  private extractFromFrontmatter(symbols: SymbolReference[]): ExtractedReference[] {
    return symbols.map((s) => ({
      name: s.name,
      channel: 'frontmatter' as ReferenceChannel,
      repo: s.repo,
      filePath: s.path,
      rawText: `${s.repo}/${s.path}#${s.name}`,
    }));
  }

  private extractFromInlineCode(body: string): ExtractedReference[] {
    const refs: ExtractedReference[] = [];
    const seen = new Set<string>();
    const pattern = /`([A-Za-z_$][A-Za-z0-9_$]{2,})`/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const name = match[1]!;
      // Require at least one capital letter (filters plain lowercase words).
      if (!/[A-Z]/.test(name)) continue;
      if (IDENTIFIER_STOPLIST.has(name.toLowerCase())) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      refs.push({ name, channel: 'inline-code', rawText: `\`${name}\`` });
    }
    return refs;
  }

  private extractFromFencedImports(body: string): ExtractedReference[] {
    const refs: ExtractedReference[] = [];
    const seen = new Set<string>();
    const codeBlockPattern = /```[\w]*\n([\s\S]*?)```/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = codeBlockPattern.exec(body)) !== null) {
      const code = blockMatch[1]!;
      const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
      const importPattern = /import\b(?:.*?\bfrom\s+)?['"]([^'"]+)['"]/g;
      for (const pat of [requirePattern, importPattern]) {
        let m: RegExpExecArray | null;
        while ((m = pat.exec(code)) !== null) {
          const importPath = m[1]!;
          // Only resolve relative imports — package imports are external.
          if (!importPath.startsWith('.')) continue;
          if (seen.has(importPath)) continue;
          seen.add(importPath);
          // Use the last path segment (without extension) as the lookup name.
          const segment = pathSegment(importPath);
          if (!segment) continue;
          refs.push({
            name: segment,
            channel: 'fenced-import',
            filePath: importPath,
            rawText: m[0]!,
          });
        }
      }
    }
    return refs;
  }

  private extractFromGraphLinks(body: string): ExtractedReference[] {
    const refs: ExtractedReference[] = [];
    // Matches graph://symbol/<repo>/<path>#<symbolName>
    const pattern = /graph:\/\/symbol\/([^/\s"')]+)\/([^#\s"')]+)#([^\s"')>]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      refs.push({
        name: match[3]!,
        channel: 'graph-link',
        repo: match[1]!,
        filePath: match[2]!,
        rawText: match[0]!,
      });
    }
    return refs;
  }

  // ─── Reference resolution ────────────────────────────────────────────────

  private async resolveReference(
    ref: ExtractedReference,
    fm: Record<string, unknown>,
  ): Promise<ResolvedReference | null> {
    // Highest confidence: all three coordinates present (from frontmatter or graph:// link).
    if (ref.repo && ref.filePath && ref.channel !== 'fenced-import') {
      const sym = await this.resolveExact(ref.repo, ref.filePath, ref.name);
      if (sym) {
        return {
          original: ref,
          entityType: 'symbol',
          repo: sym.repo,
          filePath: sym.filePath,
          symbolName: sym.name,
          confidence: 'exact',
        };
      }
    }

    // For fenced imports, try to match a Module by path segment.
    if (ref.channel === 'fenced-import') {
      const mod = await this.resolveModule(ref.name);
      if (mod) {
        return {
          original: ref,
          entityType: 'module',
          repo: mod.repo,
          filePath: mod.path,
          confidence: 'exact',
        };
      }
      return null;
    }

    // Exact (repo, name) using service context from frontmatter.
    const serviceRepo = (fm['service'] ?? fm['app']) as string | undefined;
    if (serviceRepo) {
      const sym = await this.resolveByRepoAndName(serviceRepo, ref.name);
      if (sym) {
        return {
          original: ref,
          entityType: 'symbol',
          repo: sym.repo,
          filePath: sym.filePath,
          symbolName: sym.name,
          confidence: 'exact',
        };
      }
    }

    // Fuzzy: fulltext search scoped by domain or repo.
    const domain = fm['domain'] as string | undefined;
    const sym = await this.resolveFuzzy(ref.name, serviceRepo, domain);
    if (sym) {
      return {
        original: ref,
        entityType: 'symbol',
        repo: sym.repo,
        filePath: sym.filePath,
        symbolName: sym.name,
        confidence: 'fuzzy',
      };
    }

    return null;
  }

  private async resolveExact(
    repo: string,
    filePath: string,
    name: string,
  ): Promise<{ repo: string; filePath: string; name: string } | null> {
    const rows = await this.deps.graph.runRead(
      `MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $name})
       RETURN s.repo AS repo, s.filePath AS filePath, s.name AS name
       LIMIT 1`,
      { repo, filePath, name },
      (r) => ({
        repo: String(r.get('repo')),
        filePath: String(r.get('filePath')),
        name: String(r.get('name')),
      }),
    );
    return rows[0] ?? null;
  }

  private async resolveByRepoAndName(
    repo: string,
    name: string,
  ): Promise<{ repo: string; filePath: string; name: string } | null> {
    const rows = await this.deps.graph.runRead(
      `MATCH (s:Symbol {repo: $repo, name: $name})
       RETURN s.repo AS repo, s.filePath AS filePath, s.name AS name
       LIMIT 1`,
      { repo, name },
      (r) => ({
        repo: String(r.get('repo')),
        filePath: String(r.get('filePath')),
        name: String(r.get('name')),
      }),
    );
    return rows[0] ?? null;
  }

  private async resolveModule(
    nameSegment: string,
  ): Promise<{ repo: string; path: string } | null> {
    const rows = await this.deps.graph.runRead(
      `MATCH (m:Module)
       WHERE m.path ENDS WITH $suffix OR m.path ENDS WITH $suffixTs OR m.path ENDS WITH $suffixJs
       RETURN m.repo AS repo, m.path AS path
       LIMIT 1`,
      {
        suffix: `/${nameSegment}`,
        suffixTs: `/${nameSegment}.ts`,
        suffixJs: `/${nameSegment}.js`,
      },
      (r) => ({ repo: String(r.get('repo')), path: String(r.get('path')) }),
    );
    return rows[0] ?? null;
  }

  private async resolveFuzzy(
    name: string,
    repo: string | undefined,
    domain: string | undefined,
  ): Promise<{ repo: string; filePath: string; name: string } | null> {
    const threshold = this.deps.config.fuzzyConfidenceThreshold;
    if (threshold >= 1) return null;

    // Use fulltext index for fuzzy matching.
    const rows = await this.deps.graph.runRead(
      `CALL db.index.fulltext.queryNodes('symbol_name_ft', $query) YIELD node AS s, score
       WHERE score >= $threshold
         AND ($repo IS NULL OR s.repo = $repo)
         AND ($domain IS NULL OR EXISTS {
           MATCH (s)<-[:DEFINES]-(m:Module)-[:BELONGS_TO]->()-[:IN_DOMAIN]->(d)
           WHERE d.name = $domain
         })
       RETURN s.repo AS repo, s.filePath AS filePath, s.name AS name, score
       ORDER BY score DESC
       LIMIT 1`,
      { query: name, threshold, repo: repo ?? null, domain: domain ?? null },
      (r) => ({
        repo: String(r.get('repo')),
        filePath: String(r.get('filePath')),
        name: String(r.get('name')),
      }),
    );
    return rows[0] ?? null;
  }

  // ─── Edge writes ─────────────────────────────────────────────────────────

  private async writeDocumentedByEdges(
    docPath: string,
    symbols: SymbolReference[],
  ): Promise<number> {
    if (symbols.length === 0) return 0;
    const rows = await this.deps.graph.runWrite(
      `MERGE (d:Document {path: $docPath})
       WITH d
       UNWIND $symbols AS sym
       MATCH (s:Symbol {repo: sym.repo, filePath: sym.path, name: sym.name})
       MERGE (d)-[r:DOCUMENTED_BY]->(s)
       RETURN count(r) AS n`,
      {
        docPath,
        symbols: symbols.map((s) => ({ repo: s.repo, path: s.path, name: s.name })),
      },
      (r) => Number(r.get('n')),
    );
    return rows[0] ?? 0;
  }

  private async writeReferencesEdges(
    docPath: string,
    resolved: ResolvedReference[],
  ): Promise<number> {
    if (resolved.length === 0) return 0;

    const symbolRefs = resolved.filter((r) => r.entityType === 'symbol');
    const moduleRefs = resolved.filter((r) => r.entityType === 'module');
    let total = 0;

    if (symbolRefs.length > 0) {
      const rows = await this.deps.graph.runWrite(
        `MERGE (d:Document {path: $docPath})
         WITH d
         UNWIND $refs AS ref
         MATCH (s:Symbol {repo: ref.repo, filePath: ref.filePath, name: ref.symbolName})
         MERGE (d)-[r:REFERENCES]->(s)
         SET r.confidence = ref.confidence,
             r.channel    = ref.channel
         RETURN count(r) AS n`,
        {
          docPath,
          refs: symbolRefs.map((r) => ({
            repo: r.repo,
            filePath: r.filePath,
            symbolName: r.symbolName!,
            confidence: r.confidence,
            channel: r.original.channel,
          })),
        },
        (r) => Number(r.get('n')),
      );
      total += rows[0] ?? 0;
    }

    if (moduleRefs.length > 0) {
      const rows = await this.deps.graph.runWrite(
        `MERGE (d:Document {path: $docPath})
         WITH d
         UNWIND $refs AS ref
         MATCH (m:Module {repo: ref.repo, path: ref.filePath})
         MERGE (d)-[r:REFERENCES]->(m)
         SET r.confidence = ref.confidence,
             r.channel    = ref.channel
         RETURN count(r) AS n`,
        {
          docPath,
          refs: moduleRefs.map((r) => ({
            repo: r.repo,
            filePath: r.filePath,
            confidence: r.confidence,
            channel: r.original.channel,
          })),
        },
        (r) => Number(r.get('n')),
      );
      total += rows[0] ?? 0;
    }

    return total;
  }

  // ─── Related Code section ────────────────────────────────────────────────

  private async updateRelatedCodeSection(
    docPath: string,
    resolved: ResolvedReference[],
    content: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const lines = resolved.map((r) => {
      if (r.entityType === 'symbol' && r.symbolName) {
        const link = `graph://symbol/${r.repo}/${r.filePath}#${r.symbolName}`;
        return `- \`${r.symbolName}\`: [${r.filePath}](${link})`;
      }
      const link = `graph://symbol/${r.repo}/${r.filePath}`;
      return `- [${r.filePath}](${link})`;
    });

    const newSection = [
      RELATED_CODE_BEGIN,
      '## Related Code',
      '',
      ...lines,
      '',
      `_Last updated: ${now}_`,
      RELATED_CODE_END,
    ].join('\n');

    const beginIdx = content.indexOf(RELATED_CODE_BEGIN);
    const endIdx = content.indexOf(RELATED_CODE_END);

    let updated: string;
    if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
      updated = content.slice(0, beginIdx) + newSection + content.slice(endIdx + RELATED_CODE_END.length);
    } else if (beginIdx === -1 && endIdx === -1) {
      const trimmed = content.trimEnd();
      updated = trimmed + '\n\n' + newSection + '\n';
    } else {
      // Partial/corrupted markers — leave the file untouched.
      return false;
    }

    if (updated === content) return false;

    const buf = Buffer.from(updated, 'utf8');
    await this.deps.store.put(docPath, buf, {
      contentType: 'text/markdown',
      contentLength: buf.byteLength,
      lastModified: new Date(),
      custom: { enriched: 'true' },
    });
    return true;
  }

  // ─── Hash tracking ───────────────────────────────────────────────────────

  private async getDocumentHash(docPath: string): Promise<string | null> {
    const rows = await this.deps.graph.runRead(
      `MATCH (d:Document {path: $path})
       RETURN d.lastEnrichedHash AS h`,
      { path: docPath },
      (r) => {
        const v = r.get('h');
        return v == null ? null : String(v);
      },
    );
    return rows[0] ?? null;
  }

  private async setDocumentHash(docPath: string, hash: string): Promise<void> {
    await this.deps.graph.runWrite(
      `MERGE (d:Document {path: $path})
       SET d.lastEnrichedHash = $hash`,
      { path: docPath, hash },
    );
  }

  // ─── Doc hierarchy ───────────────────────────────────────────────────────

  private async materializeDocHierarchy(): Promise<void> {
    const initBytes = await this.deps.store.get(DOC_GRAPH_INIT_KEY);
    if (initBytes) return;

    this.log.info('materializing doc hierarchy');

    for (const dir of DOC_HIERARCHY_DIRS) {
      const keepPath = `${dir}.keep`;
      const existing = await this.deps.store.head(keepPath);
      if (existing) continue;
      const buf = Buffer.from('', 'utf8');
      await this.deps.store.put(keepPath, buf, {
        contentType: 'text/plain',
        contentLength: 0,
        lastModified: new Date(),
        custom: { kind: 'hierarchy-placeholder' },
      });
    }

    // Apply override templates from _meta/templates/.overrides/ if they exist.
    await this.applyTemplateOverrides();

    const initBuf = Buffer.from(new Date().toISOString(), 'utf8');
    await this.deps.store.put(DOC_GRAPH_INIT_KEY, initBuf, {
      contentType: 'text/plain',
      contentLength: initBuf.byteLength,
      lastModified: new Date(),
      custom: { kind: 'init-marker' },
    });
  }

  private async applyTemplateOverrides(): Promise<void> {
    const overridesPrefix = '_meta/templates/.overrides/';
    const templatesPrefix = '_meta/templates/';
    for await (const head of this.deps.store.list(overridesPrefix)) {
      const relativePath = head.path.slice(overridesPrefix.length);
      const targetPath = `${templatesPrefix}${relativePath}`;
      const existing = await this.deps.store.head(targetPath);
      if (existing) continue;
      const bytes = await this.deps.store.get(head.path);
      if (!bytes) continue;
      await this.deps.store.put(targetPath, bytes.content, {
        ...bytes.metadata,
        lastModified: new Date(),
        custom: { ...bytes.metadata.custom, overrideApplied: 'true' },
      });
    }
  }

  // ─── Run record persistence ──────────────────────────────────────────────

  private async saveRunRecord(record: DocGraphRunRecord): Promise<void> {
    const content = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
    await this.deps.store.put(runRecordPath(record.runId), content, {
      contentType: 'application/json',
      contentLength: content.byteLength,
      lastModified: new Date(),
      custom: { kind: 'doc-graph-run', status: record.status },
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyStats(): DocGraphRunStats {
  return {
    docsScanned: 0,
    docsSkipped: 0,
    referencesFound: 0,
    referencesResolved: 0,
    referencesUnresolved: 0,
    edgesWritten: 0,
    docsUpdated: 0,
    errors: [],
  };
}

function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function runRecordPath(runId: string): string {
  return `${DOC_GRAPH_RUNS_PREFIX}${runId}.json`;
}

function pathSegment(importPath: string): string {
  const last = importPath.split('/').at(-1) ?? '';
  return last.replace(/\.[^.]+$/, '');
}

