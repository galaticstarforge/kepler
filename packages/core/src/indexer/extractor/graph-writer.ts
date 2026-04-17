import type { BehavioralResult, ExtractionResult } from '@kepler/shared';

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

  async writeBehavioral(repo: string, filePath: string, result: BehavioralResult): Promise<void> {
    const step = (name: string) => ({ repo, filePath, step: name });

    // Update module docstring
    if (result.moduleDocstring) {
      await this.run(
        step('set-module-docstring'),
        `MATCH (m:Module {repo: $repo, path: $filePath})
         SET m.docstring = $docstring`,
        { repo, filePath, docstring: result.moduleDocstring },
      );
    }

    // Set behavioral properties on symbol nodes
    if (result.symbolBehaviors.length > 0) {
      await this.run(
        step('set-symbol-behaviors'),
        `UNWIND $behaviors AS b
         MATCH (s:Symbol {repo: b.repo, filePath: b.filePath, name: b.name})
         SET s.docstring        = b.docstring,
             s.hasIO            = b.hasIO,
             s.hasMutation      = b.hasMutation,
             s.isPure           = b.isPure,
             s.effectKinds      = b.effectKinds,
             s.configKeysRead   = b.configKeysRead,
             s.featureFlagsRead = b.featureFlagsRead,
             s.throwTypes       = b.throwTypes`,
        { behaviors: result.symbolBehaviors },
      );
    }

    // Merge FlagDefinition nodes and READS_FLAG edges
    for (const flag of result.flags) {
      await this.run(
        step('merge-flag'),
        `MERGE (f:FlagDefinition {repo: $repo, name: $flagName})
         SET f.providerHint = $providerHint
         WITH f
         MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: $symbolName})
         MERGE (s)-[r:READS_FLAG]->(f)
         SET r.checkKind = $checkKind`,
        {
          repo: flag.repo,
          flagName: flag.name,
          providerHint: flag.providerHint,
          filePath: flag.filePath,
          symbolName: flag.symbolName,
          checkKind: flag.checkKind,
        },
      );
    }

    // Merge ExternalService nodes and IMPORTS_SERVICE edges from the module
    for (const svc of result.externalServices) {
      await this.run(
        step('merge-external-service'),
        `MERGE (e:ExternalService {repo: $repo, name: $svcName})
         SET e.protocol        = $protocol,
             e.detectionMethod = $detectionMethod
         WITH e
         MATCH (m:Module {repo: $repo, path: $filePath})
         MERGE (m)-[:IMPORTS_SERVICE]->(e)`,
        {
          repo: svc.repo,
          svcName: svc.name,
          protocol: svc.protocol,
          detectionMethod: svc.detectionMethod,
          filePath: svc.filePath,
        },
      );
    }

    // Build edge rows from symbol behaviors.
    const throwsRows: Array<{ name: string; errorType: string }> = [];
    const catchesRows: Array<{ name: string; errorType: string; catchBlock: string }> = [];
    const configReadRows: Array<{ name: string; key: string }> = [];
    const serviceCallRows: Array<{ name: string; service: string }> = [];

    for (const b of result.symbolBehaviors) {
      for (const t of b.throwTypes) throwsRows.push({ name: b.name, errorType: t });
      for (const c of b.catches)
        catchesRows.push({ name: b.name, errorType: c.errorType, catchBlock: c.catchBlock });
      for (const k of b.configKeysRead) configReadRows.push({ name: b.name, key: k });
      for (const s of b.serviceCalls) serviceCallRows.push({ name: b.name, service: s });
    }

    // ErrorFlow nodes + THROWS edges
    if (throwsRows.length > 0) {
      await this.run(
        step('throws-edges'),
        `UNWIND $rows AS row
         MERGE (e:ErrorFlow {repo: $repo, errorType: row.errorType})
         WITH e, row
         MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: row.name})
         MERGE (s)-[r:THROWS]->(e)
         SET r.propagated = false,
             r.confidence = 'exact'`,
        { repo, filePath, rows: throwsRows },
      );
    }

    // ErrorFlow nodes + CATCHES edges
    if (catchesRows.length > 0) {
      await this.run(
        step('catches-edges'),
        `UNWIND $rows AS row
         MERGE (e:ErrorFlow {repo: $repo, errorType: row.errorType})
         WITH e, row
         MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: row.name})
         MERGE (s)-[r:CATCHES]->(e)
         SET r.catchBlock = row.catchBlock`,
        { repo, filePath, rows: catchesRows },
      );
    }

    // ConfigItem nodes + READS_CONFIG edges
    if (configReadRows.length > 0) {
      await this.run(
        step('reads-config-edges'),
        `UNWIND $rows AS row
         MERGE (c:ConfigItem {repo: $repo, key: row.key})
         WITH c, row
         MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: row.name})
         MERGE (s)-[r:READS_CONFIG]->(c)
         SET r.accessPattern = 'direct',
             r.confidence    = 'exact'`,
        { repo, filePath, rows: configReadRows },
      );
    }

    // Symbol-level CALLS_SERVICE edges
    if (serviceCallRows.length > 0) {
      await this.run(
        step('calls-service-edges'),
        `UNWIND $rows AS row
         MATCH (e:ExternalService {repo: $repo, name: row.service})
         MATCH (s:Symbol {repo: $repo, filePath: $filePath, name: row.name})
         MERGE (s)-[r:CALLS_SERVICE]->(e)
         SET r.protocol   = e.protocol,
             r.confidence = 'exact'`,
        { repo, filePath, rows: serviceCallRows },
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
