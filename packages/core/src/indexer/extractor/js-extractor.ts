import path from 'node:path';

import ts from 'typescript';

import type {
  CallSiteData,
  CommentData,
  CommentKind,
  ExternalPackageData,
  ExtractionResult,
  ImportsEdgeProps,
  ModuleData,
  ModuleSystem,
  Mutability,
  ReferenceData,
  ScopeData,
  ScopeKind,
  ScopeNodeKind,
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
  scopes: ScopeData[];
  comments: CommentData[];
  references: ReferenceData[];
  seenCommentPositions: Set<number>;
  scopeStack: string[];
  nextScopeId: number;
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
      scopes: [],
      comments: [],
      references: [],
      seenCommentPositions: new Set(),
      scopeStack: [],
      nextScopeId: 0,
    };

    // Module scope wraps everything.
    const moduleScopeId = openScope(ctx, {
      kind: 'module',
      lineStart: 1,
      lineEnd: sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1,
      isStrict: sourceFileIsStrict(sourceFile, content),
    });

    // Walk top-level statements
    for (const stmt of sourceFile.statements) {
      visitStatement(stmt, ctx);
    }

    // Walk the entire file for call sites
    visitForCallSites(sourceFile, ctx);

    // Walk the entire file for scope/reference primitives.
    visitForScopes(sourceFile, ctx);
    visitForReferences(sourceFile, ctx);

    // Collect comments from the full text.
    collectComments(sourceFile, content, ctx);

    closeScope(ctx, moduleScopeId);

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
      scopes: ctx.scopes,
      comments: ctx.comments,
      references: ctx.references,
    };
  }
}

// ─── Statement visitors ───────────────────────────────────────────────────────

function visitStatement(node: ts.Statement, ctx: VisitorCtx): void {
  switch (node.kind) {
    case ts.SyntaxKind.ImportDeclaration: {
      visitImport(node as ts.ImportDeclaration, ctx);
      break;
    }
    case ts.SyntaxKind.ExportDeclaration: {
      visitExportDeclaration(node as ts.ExportDeclaration, ctx);
      break;
    }
    case ts.SyntaxKind.ExportAssignment: {
      visitExportAssignment(node as ts.ExportAssignment, ctx);
      break;
    }
    case ts.SyntaxKind.FunctionDeclaration: {
      visitFunctionDeclaration(node as ts.FunctionDeclaration, ctx);
      break;
    }
    case ts.SyntaxKind.ClassDeclaration: {
      visitClassDeclaration(node as ts.ClassDeclaration, ctx);
      break;
    }
    case ts.SyntaxKind.VariableStatement: {
      visitVariableStatement(node as ts.VariableStatement, ctx);
      break;
    }
    case ts.SyntaxKind.ExpressionStatement: {
      ctx.hasTopLevelSideEffect = true;
      break;
    }
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

    if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
      kind = 'function';
      isAsync = !!decl.initializer.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
      );
      isGenerator = !!(decl.initializer as ts.FunctionExpression).asteriskToken;
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
    if (!ctx.exports.some((e) => e.symbolName === name)) {
      ctx.exports.push({
        symbolName: name,
        props: { exportName: name, isDefault: false },
      });
    }
  }

  // export default <identifier>
  if (ctx.defaultExportedName && !ctx.exports.some((e) => e.props.isDefault)) {
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

// ─── Scope emission ───────────────────────────────────────────────────────────

interface ScopeOpenArgs {
  kind: ScopeNodeKind;
  lineStart: number;
  lineEnd: number;
  isStrict: boolean;
}

function openScope(ctx: VisitorCtx, args: ScopeOpenArgs): string {
  const id = `s${ctx.nextScopeId++}`;
  const parentId = ctx.scopeStack.at(-1) ?? null;
  ctx.scopes.push({
    repo: ctx.repo,
    filePath: ctx.filePath,
    kind: args.kind,
    lineStart: args.lineStart,
    lineEnd: args.lineEnd,
    isStrict: args.isStrict,
    id,
    parentId,
  });
  ctx.scopeStack.push(id);
  return id;
}

function closeScope(ctx: VisitorCtx, id: string): void {
  const top = ctx.scopeStack.at(-1);
  if (top === id) ctx.scopeStack.pop();
}

function sourceFileIsStrict(sourceFile: ts.SourceFile, content: string): boolean {
  // ES modules are always strict — any import/export syntax marks the file as a module.
  if ((sourceFile as unknown as { externalModuleIndicator?: ts.Node }).externalModuleIndicator) {
    return true;
  }
  for (const stmt of sourceFile.statements) {
    if (
      stmt.kind === ts.SyntaxKind.ImportDeclaration ||
      stmt.kind === ts.SyntaxKind.ExportDeclaration ||
      stmt.kind === ts.SyntaxKind.ExportAssignment
    ) {
      return true;
    }
    if (ts.canHaveModifiers(stmt)) {
      const mods = ts.getModifiers(stmt) ?? [];
      if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    }
  }
  // "use strict" directive detection — look in the leading chunk only.
  const head = content.slice(0, 200);
  return /^[\s;]*(['"])use strict\1\s*;?/m.test(head);
}

function scopeKindForNode(node: ts.Node): ScopeNodeKind | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return 'function';
  }
  if (ts.isBlock(node)) {
    // Skip Block when it's directly the body of a function-like — already represented.
    const parent = node.parent;
    if (
      parent &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isConstructorDeclaration(parent))
    ) {
      return null;
    }
    return 'block';
  }
  if (ts.isCatchClause(node)) return 'catch';
  if (ts.isWithStatement(node)) return 'with';
  return null;
}

function visitForScopes(sourceFile: ts.SourceFile, ctx: VisitorCtx): void {
  const walk = (node: ts.Node): void => {
    const kind = scopeKindForNode(node);
    let opened: string | null = null;
    if (kind) {
      const { line, endLine } = lineRange(node, sourceFile);
      opened = openScope(ctx, { kind, lineStart: line, lineEnd: endLine, isStrict: false });
    }
    ts.forEachChild(node, walk);
    if (opened) closeScope(ctx, opened);
  };
  ts.forEachChild(sourceFile, walk);
}

// ─── Reference emission ───────────────────────────────────────────────────────

function visitForReferences(sourceFile: ts.SourceFile, ctx: VisitorCtx): void {
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const parent = node.parent;
      const isCall = !!parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.expression === node;
      const { isRead, isWrite } = classifyReadWrite(node);
      const bindingKind: ReferenceData['bindingKind'] =
        parent && ts.isElementAccessExpression(parent) && parent.argumentExpression === node
          ? 'computed'
          : 'static';
      const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
      ctx.references.push({
        repo: ctx.repo,
        filePath: ctx.filePath,
        name: node.text,
        bindingKind,
        isRead,
        isWrite,
        isCall,
        line: pos.line + 1,
        column: pos.character + 1,
        confidence: 'heuristic',
      });
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
}

function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent)) &&
    (parent as { name?: ts.Node }).name === id
  ) {
    return true;
  }
  // Property access: `obj.foo` — `foo` is a property reference, not a declaration.
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    return false;
  }
  // Labelled statement label
  if (ts.isLabeledStatement(parent) && parent.label === id) return true;
  return false;
}

function classifyReadWrite(id: ts.Identifier): { isRead: boolean; isWrite: boolean } {
  const parent = id.parent;
  if (!parent) return { isRead: true, isWrite: false };
  if (ts.isBinaryExpression(parent) && parent.left === id) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) return { isRead: false, isWrite: true };
    if (
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken ||
      op === ts.SyntaxKind.PercentEqualsToken ||
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      return { isRead: true, isWrite: true };
    }
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return { isRead: true, isWrite: true };
  }
  return { isRead: true, isWrite: false };
}

// ─── Comment emission ─────────────────────────────────────────────────────────

function collectComments(sourceFile: ts.SourceFile, content: string, ctx: VisitorCtx): void {
  // Shebang — first line only.
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    const end = nl === -1 ? content.length : nl;
    ctx.comments.push({
      repo: ctx.repo,
      filePath: ctx.filePath,
      kind: 'shebang',
      text: content.slice(0, end),
      lineStart: 1,
      lineEnd: 1,
      hasDocTags: false,
    });
    ctx.seenCommentPositions.add(0);
  }

  const walk = (node: ts.Node): void => {
    const leading = ts.getLeadingCommentRanges(content, node.getFullStart());
    if (leading) {
      for (const range of leading) recordComment(range, content, sourceFile, ctx);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);

  // Trailing comments at EOF aren't reached by walking; sweep the top.
  const trailing = ts.getTrailingCommentRanges(content, sourceFile.getEnd());
  if (trailing) {
    for (const range of trailing) recordComment(range, content, sourceFile, ctx);
  }
}

function recordComment(
  range: ts.CommentRange,
  content: string,
  sourceFile: ts.SourceFile,
  ctx: VisitorCtx,
): void {
  if (ctx.seenCommentPositions.has(range.pos)) return;
  ctx.seenCommentPositions.add(range.pos);
  const text = content.slice(range.pos, range.end);
  const lineStart = ts.getLineAndCharacterOfPosition(sourceFile, range.pos).line + 1;
  const lineEnd = ts.getLineAndCharacterOfPosition(sourceFile, range.end).line + 1;
  const kind = classifyComment(text);
  const hasDocTags = /@\w+/.test(text);
  ctx.comments.push({
    repo: ctx.repo,
    filePath: ctx.filePath,
    kind,
    text: text.length > 2000 ? text.slice(0, 2000) : text,
    lineStart,
    lineEnd,
    hasDocTags,
  });
}

function classifyComment(text: string): CommentKind {
  if (text.startsWith('//')) return 'line';
  if (text.startsWith('/**')) return 'jsdoc';
  if (text.startsWith('/*')) {
    if (/copyright|license|spdx/i.test(text)) return 'license';
    return 'block';
  }
  return 'block';
}
