import path from 'node:path';

import ts from 'typescript';

import type {
  CallSiteData,
  ExportsEdgeProps,
  ExternalPackageData,
  ExtractionResult,
  ImportsEdgeProps,
  ModuleData,
  ModuleSystem,
  Mutability,
  ScopeKind,
  SymbolData,
  SymbolKind,
} from './types.js';

export interface JsExtractorConfig {
  repo: string;
}

interface VisitorCtx {
  repo: string;
  filePath: string;
  sourceFile: ts.SourceFile;
  symbols: SymbolData[];
  callSites: CallSiteData[];
  localImports: ExtractionResult['localImports'];
  externalPackages: ExternalPackageData[];
  exports: ExtractionResult['exports'];
  exportedNames: Set<string>;
  defaultExportedName: string | null;
  hasTopLevelSideEffect: boolean;
  seenPackages: Set<string>;
}

export class JsExtractor {
  constructor(private readonly config: JsExtractorConfig) {}

  extract(absolutePath: string, relativePath: string, content: string): ExtractionResult {
    const scriptKind = path.extname(relativePath) === '.jsx' ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(
      absolutePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const ctx: VisitorCtx = {
      repo: this.config.repo,
      filePath: relativePath,
      sourceFile,
      symbols: [],
      callSites: [],
      localImports: [],
      externalPackages: [],
      exports: [],
      exportedNames: new Set(),
      defaultExportedName: null,
      hasTopLevelSideEffect: false,
      seenPackages: new Set(),
    };

    // Walk top-level statements
    for (const stmt of sourceFile.statements) {
      visitStatement(stmt, ctx);
    }

    // Walk the entire file for call sites
    visitForCallSites(sourceFile, ctx);

    // Resolve exports list from symbols
    resolveExports(ctx);

    const moduleSystem = detectModuleSystem(sourceFile, content);
    const isBarrel = detectIsBarrel(sourceFile, ctx);

    const moduleData: ModuleData = {
      repo: this.config.repo,
      path: relativePath,
      language: 'javascript',
      dialect: 'modern',
      hash: '',  // filled in by orchestrator from DiscoveredFile.hash
      loc: content.split('\n').length,
      hasSideEffects: ctx.hasTopLevelSideEffect,
      isBarrel,
      moduleSystem,
    };

    return {
      module: moduleData,
      symbols: ctx.symbols,
      externalPackages: ctx.externalPackages,
      localImports: ctx.localImports,
      callSites: ctx.callSites,
      exports: ctx.exports,
    };
  }
}

// ─── Statement visitors ───────────────────────────────────────────────────────

function visitStatement(node: ts.Statement, ctx: VisitorCtx): void {
  switch (node.kind) {
    case ts.SyntaxKind.ImportDeclaration:
      visitImport(node as ts.ImportDeclaration, ctx);
      break;
    case ts.SyntaxKind.ExportDeclaration:
      visitExportDeclaration(node as ts.ExportDeclaration, ctx);
      break;
    case ts.SyntaxKind.ExportAssignment:
      visitExportAssignment(node as ts.ExportAssignment, ctx);
      break;
    case ts.SyntaxKind.FunctionDeclaration:
      visitFunctionDeclaration(node as ts.FunctionDeclaration, ctx);
      break;
    case ts.SyntaxKind.ClassDeclaration:
      visitClassDeclaration(node as ts.ClassDeclaration, ctx);
      break;
    case ts.SyntaxKind.VariableStatement:
      visitVariableStatement(node as ts.VariableStatement, ctx);
      break;
    case ts.SyntaxKind.ExpressionStatement:
      ctx.hasTopLevelSideEffect = true;
      break;
  }
}

function visitImport(node: ts.ImportDeclaration, ctx: VisitorCtx): void {
  const specifierText = (node.moduleSpecifier as ts.StringLiteral).text;
  const line = lineOf(node, ctx.sourceFile);

  const specifiers: string[] = [];
  const clause = node.importClause;
  if (clause) {
    if (clause.name) specifiers.push(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        specifiers.push(`* as ${bindings.name.text}`);
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          specifiers.push(el.name.text);
        }
      }
    }
  }

  const kind: ImportsEdgeProps['kind'] = (() => {
    if (clause?.isTypeOnly) return 'type';
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return 'namespace';
    return 'value';
  })();

  const props: ImportsEdgeProps = { kind, specifiers, line };

  if (specifierText.startsWith('.')) {
    // Local import — resolve relative to file location within repo
    const fileDir = path.dirname(ctx.filePath);
    const resolved = path.normalize(path.join(fileDir, specifierText));
    ctx.localImports.push({ targetPath: resolved, props });
  } else {
    // External package — extract bare package name
    const pkgName = extractPackageName(specifierText);
    if (!ctx.seenPackages.has(pkgName)) {
      ctx.seenPackages.add(pkgName);
      ctx.externalPackages.push({ name: pkgName });
    }
  }
}

function visitExportDeclaration(node: ts.ExportDeclaration, ctx: VisitorCtx): void {
  if (!node.exportClause) return;
  if (ts.isNamedExports(node.exportClause)) {
    for (const el of node.exportClause.elements) {
      ctx.exportedNames.add(el.name.text);
    }
  }
}

function visitExportAssignment(node: ts.ExportAssignment, ctx: VisitorCtx): void {
  if (ts.isIdentifier(node.expression)) {
    ctx.defaultExportedName = node.expression.text;
  }
}

function visitFunctionDeclaration(node: ts.FunctionDeclaration, ctx: VisitorCtx): void {
  if (!node.name) return;
  const name = node.name.text;
  const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const { line: lineStart, endLine: lineEnd } = lineRange(node, ctx.sourceFile);

  ctx.symbols.push({
    name,
    kind: 'function',
    scopeKind: 'module',
    isExported,
    exportKind: isExported ? (isDefault ? 'default' : 'named') : null,
    isAsync: !!node.asteriskToken === false && !!node.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    ),
    isGenerator: !!node.asteriskToken,
    mutability: null,
    lineStart,
    lineEnd,
    signature: buildFunctionSignature(name, node, ctx.sourceFile),
    repo: ctx.repo,
    filePath: ctx.filePath,
  });
}

function visitClassDeclaration(node: ts.ClassDeclaration, ctx: VisitorCtx): void {
  if (!node.name) return;
  const name = node.name.text;
  const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const { line: lineStart, endLine: lineEnd } = lineRange(node, ctx.sourceFile);

  ctx.symbols.push({
    name,
    kind: 'class',
    scopeKind: 'module',
    isExported,
    exportKind: isExported ? (isDefault ? 'default' : 'named') : null,
    isAsync: false,
    isGenerator: false,
    mutability: null,
    lineStart,
    lineEnd,
    signature: name,
    repo: ctx.repo,
    filePath: ctx.filePath,
  });
}

function visitVariableStatement(node: ts.VariableStatement, ctx: VisitorCtx): void {
  const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const flags = node.declarationList.flags;
  const mutability: Mutability =
    flags & ts.NodeFlags.Const ? 'const' :
    flags & ts.NodeFlags.Let ? 'let' :
    'var';
  const scopeKind: ScopeKind = mutability === 'var' ? 'function' : 'block';

  for (const decl of node.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    const name = decl.name.text;
    const { line: lineStart, endLine: lineEnd } = lineRange(decl, ctx.sourceFile);

    let kind: SymbolKind = 'variable';
    let isAsync = false;
    let isGenerator = false;

    if (decl.initializer) {
      if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
        kind = 'function';
        isAsync = !!decl.initializer.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        );
        isGenerator = !!(decl.initializer as ts.FunctionExpression).asteriskToken;
      }
    }

    ctx.symbols.push({
      name,
      kind,
      scopeKind,
      isExported,
      exportKind: isExported ? 'named' : null,
      isAsync,
      isGenerator,
      mutability,
      lineStart,
      lineEnd,
      signature: kind === 'function' ? buildArrowSignature(name, decl, ctx.sourceFile) : name,
      repo: ctx.repo,
      filePath: ctx.filePath,
    });
  }
}

// ─── Call site collection ─────────────────────────────────────────────────────

function visitForCallSites(node: ts.Node, ctx: VisitorCtx): void {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const calleeExpr = node.expression.getText(ctx.sourceFile);
    ctx.callSites.push({
      calleeExpression: calleeExpr.slice(0, 200),
      argumentCount: node.arguments?.length ?? 0,
      isNewExpression: ts.isNewExpression(node),
      line: lineOf(node, ctx.sourceFile),
      resolutionStatus: 'heuristic',
      repo: ctx.repo,
      filePath: ctx.filePath,
    });
  }
  ts.forEachChild(node, (child) => visitForCallSites(child, ctx));
}

// ─── Export resolution ────────────────────────────────────────────────────────

function resolveExports(ctx: VisitorCtx): void {
  // Symbols that declared themselves exported
  for (const sym of ctx.symbols) {
    if (sym.isExported) {
      ctx.exports.push({
        symbolName: sym.name,
        props: {
          exportName: sym.exportKind === 'default' ? 'default' : sym.name,
          isDefault: sym.exportKind === 'default',
        },
      });
    }
  }

  // Names in separate export statements not already accounted for
  for (const name of ctx.exportedNames) {
    if (!ctx.exports.find((e) => e.symbolName === name)) {
      ctx.exports.push({
        symbolName: name,
        props: { exportName: name, isDefault: false },
      });
    }
  }

  // export default <identifier>
  if (ctx.defaultExportedName && !ctx.exports.find((e) => e.props.isDefault)) {
    ctx.exports.push({
      symbolName: ctx.defaultExportedName,
      props: { exportName: 'default', isDefault: true },
    });
  }
}

// ─── Module-level analysis ────────────────────────────────────────────────────

function detectModuleSystem(sourceFile: ts.SourceFile, content: string): ModuleSystem {
  let hasEsm = false;
  let hasCjs = false;

  for (const stmt of sourceFile.statements) {
    if (stmt.kind === ts.SyntaxKind.ImportDeclaration || stmt.kind === ts.SyntaxKind.ExportDeclaration) {
      hasEsm = true;
    }
  }

  // Cheap heuristic for CommonJS — look for require( or module.exports
  if (content.includes('require(') || content.includes('module.exports')) {
    hasCjs = true;
  }

  if (hasEsm && hasCjs) return 'mixed';
  if (hasEsm) return 'esm';
  if (hasCjs) return 'commonjs';
  return 'none';
}

function detectIsBarrel(sourceFile: ts.SourceFile, ctx: VisitorCtx): boolean {
  if (ctx.symbols.length > 0) return false;
  // A barrel only re-exports; check for export ... from '...'
  for (const stmt of sourceFile.statements) {
    if (
      stmt.kind === ts.SyntaxKind.ExportDeclaration &&
      (stmt as ts.ExportDeclaration).moduleSpecifier !== undefined
    ) {
      return true;
    }
  }
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

function lineRange(node: ts.Node, sourceFile: ts.SourceFile): { line: number; endLine: number } {
  const line = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
  const endLine = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd()).line + 1;
  return { line, endLine };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
    : false;
}

function buildFunctionSignature(name: string, node: ts.FunctionDeclaration, sf: ts.SourceFile): string {
  const params = node.parameters.map((p) => p.getText(sf)).join(', ');
  const ret = node.type ? `: ${node.type.getText(sf)}` : '';
  return `${name}(${params})${ret}`;
}

function buildArrowSignature(name: string, decl: ts.VariableDeclaration, sf: ts.SourceFile): string {
  if (!decl.initializer) return name;
  if (!ts.isArrowFunction(decl.initializer) && !ts.isFunctionExpression(decl.initializer)) return name;
  const fn = decl.initializer;
  const params = fn.parameters.map((p) => p.getText(sf)).join(', ');
  const ret = fn.type ? `: ${fn.type.getText(sf)}` : '';
  return `${name}(${params})${ret}`;
}

function extractPackageName(specifier: string): string {
  // Handle scoped packages like @scope/pkg/sub → @scope/pkg
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  // Handle path submodules like lodash/merge → lodash
  return specifier.split('/')[0] ?? specifier;
}
