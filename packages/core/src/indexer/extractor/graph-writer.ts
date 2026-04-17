import type { ExtractionResult } from '@kepler/shared';

import type { GraphClient } from '../../graph/graph-client.js';
import { createLogger, type Logger } from '../../logger.js';

export interface GraphWriterDeps {
  graph: GraphClient;
  logger?: Logger;
}

export class GraphWriter {
  private readonly log: Logger;

  constructor(private readonly deps: GraphWriterDeps) {
    this.log = deps.logger ?? createLogger('graph-writer');
  }

  async write(result: ExtractionResult): Promise<void> {
    const { repo, path: filePath } = result.module;
    const step = (name: string) => ({ repo, filePath, step: name });

    // 1. Delete old CallSites so re-indexed files don't accumulate stale nodes
    await this.run(
      step('delete-callsites'),
      `MATCH (m:Module {repo: $repo, path: $filePath})-[:CONTAINS]->(cs:CallSite)
       DETACH DELETE cs`,
      { repo, filePath },
    );

    // 2. Upsert Module
    await this.run(
      step('merge-module'),
      `MERGE (m:Module {repo: $repo, path: $path})
       SET m.language       = $language,
           m.dialect        = $dialect,
           m.hash           = $hash,
           m.loc            = $loc,
           m.hasSideEffects = $hasSideEffects,
           m.isBarrel       = $isBarrel,
           m.moduleSystem   = $moduleSystem`,
      {
        repo,
        path: filePath,
        language: result.module.language,
        dialect: result.module.dialect,
        hash: result.module.hash,
        loc: result.module.loc,
        hasSideEffects: result.module.hasSideEffects,
        isBarrel: result.module.isBarrel,
        moduleSystem: result.module.moduleSystem,
      },
    );

    // 3. Upsert Symbols + CONTAINS edges
    if (result.symbols.length > 0) {
      await this.run(
        step('merge-symbols'),
        `MATCH (m:Module {repo: $repo, path: $filePath})
         UNWIND $symbols AS s
         MERGE (sym:Symbol {repo: s.repo, filePath: s.filePath, name: s.name})
         SET sym.kind        = s.kind,
             sym.scopeKind   = s.scopeKind,
             sym.isExported  = s.isExported,
             sym.exportKind  = s.exportKind,
             sym.isAsync     = s.isAsync,
             sym.isGenerator = s.isGenerator,
             sym.mutability  = s.mutability,
             sym.lineStart   = s.lineStart,
             sym.lineEnd     = s.lineEnd,
             sym.signature   = s.signature
         MERGE (m)-[:CONTAINS]->(sym)`,
        { repo, filePath, symbols: result.symbols },
      );
    }

    // 4. Upsert EXPORTS edges
    if (result.exports.length > 0) {
      await this.run(
        step('merge-exports'),
        `MATCH (m:Module {repo: $repo, path: $filePath})
         UNWIND $exports AS e
         MATCH (sym:Symbol {repo: $repo, filePath: $filePath, name: e.symbolName})
         MERGE (m)-[r:EXPORTS]->(sym)
         SET r.exportName = e.props.exportName,
             r.isDefault  = e.props.isDefault`,
        { repo, filePath, exports: result.exports },
      );
    }

    // 5. Upsert ExternalPackage nodes + IMPORTS edges
    if (result.externalPackages.length > 0) {
      await this.run(
        step('merge-external-imports'),
        `MATCH (m:Module {repo: $repo, path: $filePath})
         UNWIND $packages AS p
         MERGE (ep:ExternalPackage {name: p.name})
         MERGE (m)-[:IMPORTS]->(ep)`,
        { repo, filePath, packages: result.externalPackages },
      );
    }

    // 6. Upsert local IMPORTS edges (creates stub Module for not-yet-indexed targets)
    if (result.localImports.length > 0) {
      await this.run(
        step('merge-local-imports'),
        `MATCH (m:Module {repo: $repo, path: $filePath})
         UNWIND $imports AS i
         MERGE (target:Module {repo: $repo, path: i.targetPath})
         MERGE (m)-[r:IMPORTS]->(target)
         SET r.kind      = i.props.kind,
             r.specifiers = i.props.specifiers,
             r.line       = i.props.line`,
        { repo, filePath, imports: result.localImports },
      );
    }

    // 7. Create new CallSite nodes (CREATE — positional, not merged)
    if (result.callSites.length > 0) {
      await this.run(
        step('create-callsites'),
        `MATCH (m:Module {repo: $repo, path: $filePath})
         UNWIND $callSites AS cs
         CREATE (c:CallSite {
           calleeExpression: cs.calleeExpression,
           argumentCount:    cs.argumentCount,
           isNewExpression:  cs.isNewExpression,
           line:             cs.line,
           resolutionStatus: cs.resolutionStatus,
           repo:             cs.repo,
           filePath:         cs.filePath
         })
         MERGE (m)-[:CONTAINS]->(c)`,
        { repo, filePath, callSites: result.callSites },
      );
    }
  }

  private async run(
    ctx: { repo: string; filePath: string; step: string },
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.graph.runWrite(cypher, params);
    } catch (error) {
      this.log.error('write failed', { ...ctx, error: String(error) });
      throw error;
    }
  }
}
