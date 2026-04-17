import ts from 'typescript';

import type {
  BehavioralResult,
  EffectKind,
  ExternalServiceData,
  FlagCheckKind,
  FlagDefinitionData,
  FlagProvider,
  ServiceProtocol,
  SymbolBehavior,
  SymbolData,
} from '@kepler/shared';

// ─── SDK → service mapping ────────────────────────────────────────────────────

interface SdkEntry {
  name: string;
  protocol: ServiceProtocol;
}

const SDK_SERVICE_MAP: Record<string, SdkEntry> = {
  'stripe': { name: 'stripe', protocol: 'http' },
  '@stripe/stripe-js': { name: 'stripe', protocol: 'http' },
  '@sendgrid/mail': { name: 'sendgrid', protocol: 'http' },
  'twilio': { name: 'twilio', protocol: 'http' },
  'nodemailer': { name: 'smtp', protocol: 'http' },
  'pg': { name: 'postgres', protocol: 'http' },
  'mysql2': { name: 'mysql', protocol: 'http' },
  'mysql': { name: 'mysql', protocol: 'http' },
  'mongoose': { name: 'mongodb', protocol: 'http' },
  'redis': { name: 'redis', protocol: 'http' },
  'ioredis': { name: 'redis', protocol: 'http' },
  '@elastic/elasticsearch': { name: 'elasticsearch', protocol: 'http' },
  'elasticsearch': { name: 'elasticsearch', protocol: 'http' },
  'kafkajs': { name: 'kafka', protocol: 'amqp' },
  'amqplib': { name: 'rabbitmq', protocol: 'amqp' },
  '@aws-sdk/client-dynamodb': { name: 'dynamodb', protocol: 'http' },
  '@aws-sdk/lib-dynamodb': { name: 'dynamodb', protocol: 'http' },
  '@aws-sdk/client-s3': { name: 's3', protocol: 'http' },
  '@aws-sdk/client-sns': { name: 'sns', protocol: 'http' },
  '@aws-sdk/client-sqs': { name: 'sqs', protocol: 'http' },
  '@aws-sdk/client-lambda': { name: 'lambda', protocol: 'http' },
  '@aws-sdk/client-rds-data': { name: 'rds', protocol: 'http' },
  '@aws-sdk/client-bedrock-runtime': { name: 'bedrock', protocol: 'http' },
  'firebase-admin': { name: 'firebase', protocol: 'http' },
  'firebase': { name: 'firebase', protocol: 'http' },
  '@google-cloud/firestore': { name: 'firestore', protocol: 'http' },
  '@google-cloud/bigquery': { name: 'bigquery', protocol: 'http' },
  '@supabase/supabase-js': { name: 'supabase', protocol: 'http' },
};

// ─── Effect detection patterns ────────────────────────────────────────────────

const IO_PATTERNS: Array<{ pattern: RegExp; effect: EffectKind }> = [
  // File reads
  { pattern: /^fs\.(readFile|readdir|readlink|stat|lstat|access|open|read)\b/, effect: 'file-read' },
  { pattern: /^(readFile|readdir|stat|access)(Sync)?\b/, effect: 'file-read' },
  // File writes
  { pattern: /^fs\.(writeFile|appendFile|write|mkdir|unlink|rmdir|rename|copyFile|symlink|chmod|chown)\b/, effect: 'file-write' },
  { pattern: /^(writeFile|appendFile|mkdir|unlink|rmdir)(Sync)?\b/, effect: 'file-write' },
  // Network
  { pattern: /^fetch\b/, effect: 'network-call' },
  { pattern: /^axios(\.(get|post|put|patch|delete|head|options|request))?\b/, effect: 'network-call' },
  { pattern: /^https?\.(get|request|createServer)\b/, effect: 'network-call' },
  { pattern: /^(got|superagent|request|needle)\b/, effect: 'network-call' },
  { pattern: /^net\.(connect|createConnection|createServer)\b/, effect: 'network-call' },
  // Process spawning
  { pattern: /^(exec|execSync|spawn|spawnSync|fork|execFile|execFileSync)\b/, effect: 'process-spawn' },
  { pattern: /^child_process\./, effect: 'process-spawn' },
  // Timers (side effect but not I/O)
  { pattern: /^(setTimeout|setInterval|setImmediate)\b/, effect: 'timer' },
  // DOM
  { pattern: /^document\./, effect: 'dom-mutation' },
  // DB (well-known client patterns)
  {
    pattern: /^(dynamoDb|ddb|docClient|documentClient)\.(get|query|scan|getItem|batchGet)\b/,
    effect: 'db-read',
  },
  {
    pattern: /^(dynamoDb|ddb|docClient|documentClient)\.(put|update|delete|putItem|updateItem|deleteItem|batchWrite)\b/,
    effect: 'db-write',
  },
  { pattern: /^(db|pool|client|connection)\.(query|execute)\b/, effect: 'db-read' },
];

// These effect kinds count toward hasIO (timer and env-read are side effects, not I/O)
const IO_KINDS: ReadonlySet<EffectKind> = new Set([
  'file-read',
  'file-write',
  'network-call',
  'db-read',
  'db-write',
  'process-spawn',
  'dom-mutation',
]);

// ─── Feature flag patterns ────────────────────────────────────────────────────

interface FlagPatternEntry {
  methodNames: string[];
  provider: FlagProvider;
  checkKind: FlagCheckKind;
}

const FLAG_PATTERNS: FlagPatternEntry[] = [
  {
    methodNames: ['variation', 'boolVariation', 'stringVariation', 'numberVariation', 'jsonVariation'],
    provider: 'launchdarkly',
    checkKind: 'variant',
  },
  {
    methodNames: ['isEnabled', 'getVariant'],
    provider: 'unleash',
    checkKind: 'is-enabled',
  },
  {
    methodNames: ['isOn', 'isOff', 'getFeatureValue', 'evalFeature'],
    provider: 'growthbook',
    checkKind: 'is-enabled',
  },
];

// Generic flag method names that don't map to a known provider
const GENERIC_FLAG_METHODS = new Set([
  'isEnabled', 'isActive', 'isFlagEnabled', 'isFeatureEnabled', 'isFeatureOn',
]);

// ─── Main analyzer ────────────────────────────────────────────────────────────

interface TopLevelEntry {
  /** Node whose leading trivia holds the JSDoc comment (VariableStatement for `const x = ...`). */
  docNode: ts.Node;
  /** Node used to find the function body (VariableDeclaration or FunctionDeclaration etc.). */
  bodyNode: ts.Node;
}

// Assignment operators that constitute a mutation when targeting `this.x`
const MUTATION_OP_KINDS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

export class BehavioralAnalyzer {
  constructor(private readonly config: { repo: string }) {}

  analyze(filePath: string, content: string, symbols: SymbolData[]): BehavioralResult {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const moduleDocstring = extractModuleDocstring(sourceFile);
    const nodeMap = buildTopLevelNodeMap(sourceFile);
    const externalServices = this.detectImportedServices(sourceFile, filePath);

    const symbolBehaviors: SymbolBehavior[] = [];
    const allFlags: FlagDefinitionData[] = [];

    for (const sym of symbols) {
      if (sym.kind !== 'function' && sym.kind !== 'class') continue;
      const entry = nodeMap.get(sym.name);
      if (!entry) continue;

      const { behavior, flags } = this.analyzeSymbol(sym, entry.docNode, entry.bodyNode, sourceFile, filePath);
      symbolBehaviors.push(behavior);
      allFlags.push(...flags);
    }

    return {
      moduleDocstring,
      symbolBehaviors,
      flags: allFlags,
      externalServices,
    };
  }

  private analyzeSymbol(
    sym: SymbolData,
    docNode: ts.Node,
    bodyNode: ts.Node,
    sf: ts.SourceFile,
    filePath: string,
  ): { behavior: SymbolBehavior; flags: FlagDefinitionData[] } {
    const { repo } = this.config;
    const docstring = extractDocstring(docNode, sf);
    const body = getBodyNode(bodyNode);

    if (!body) {
      return {
        behavior: emptyBehavior(sym.name, filePath, repo, docstring, sym.kind === 'function'),
        flags: [],
      };
    }

    const effectKinds = new Set<EffectKind>();
    const configKeysRead: string[] = [];
    const featureFlagsRead: string[] = [];
    const throwTypes: string[] = [];
    const flags: FlagDefinitionData[] = [];
    let hasMutation = false;

    walk(body, (n) => {
      if (ts.isCallExpression(n)) {
        const calleeText = n.expression.getText(sf);

        for (const { pattern, effect } of IO_PATTERNS) {
          if (pattern.test(calleeText)) {
            effectKinds.add(effect);
            break;
          }
        }

        const configKey = extractConfigGetKey(n, sf);
        if (configKey !== null && !configKeysRead.includes(configKey)) {
          configKeysRead.push(configKey);
        }

        const flag = detectFlag(n, sf, sym.name, filePath, repo);
        if (flag) {
          flags.push(flag);
          if (!featureFlagsRead.includes(flag.name)) featureFlagsRead.push(flag.name);
        }
      }

      // process.env.KEY
      if (ts.isPropertyAccessExpression(n)) {
        const key = extractEnvKeyFromPropAccess(n);
        if (key !== null) {
          effectKinds.add('env-read');
          if (!configKeysRead.includes(key)) configKeysRead.push(key);
        }
      }

      // process.env['KEY']
      if (ts.isElementAccessExpression(n)) {
        const key = extractEnvKeyFromElementAccess(n);
        if (key !== null) {
          effectKinds.add('env-read');
          if (!configKeysRead.includes(key)) configKeysRead.push(key);
        }
      }

      // throw new ErrorType(...)
      if (ts.isThrowStatement(n)) {
        const errorType = extractThrowType(n, sf);
        if (errorType && !throwTypes.includes(errorType)) throwTypes.push(errorType);
      }

      // this.x = / += / -= / etc. (property mutation via assignment operators)
      if (
        ts.isBinaryExpression(n) &&
        MUTATION_OP_KINDS.has(n.operatorToken.kind) &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        hasMutation = true;
      }

      // this.x++ / this.x-- / ++this.x / --this.x
      if (
        (ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isPropertyAccessExpression(n.operand) &&
        n.operand.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        hasMutation = true;
      }
    });

    const hasIO = Array.from(effectKinds).some((k) => IO_KINDS.has(k));
    const isPure = !hasIO && !hasMutation;

    return {
      behavior: {
        name: sym.name,
        filePath,
        repo,
        docstring,
        hasIO,
        hasMutation,
        isPure,
        effectKinds: Array.from(effectKinds),
        configKeysRead,
        featureFlagsRead,
        throwTypes,
      },
      flags,
    };
  }

  private detectImportedServices(sf: ts.SourceFile, filePath: string): ExternalServiceData[] {
    const services: ExternalServiceData[] = [];
    const seen = new Set<string>();

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const entry = SDK_SERVICE_MAP[specifier];
      if (entry && !seen.has(entry.name)) {
        seen.add(entry.name);
        services.push({
          name: entry.name,
          repo: this.config.repo,
          filePath,
          symbolName: null,
          protocol: entry.protocol,
          detectionMethod: 'sdk-import',
        });
      }
    }

    return services;
  }
}

// ─── AST utilities ────────────────────────────────────────────────────────────

function walk(node: ts.Node, visitor: (n: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function buildTopLevelNodeMap(sf: ts.SourceFile): Map<string, TopLevelEntry> {
  const map = new Map<string, TopLevelEntry>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      map.set(stmt.name.text, { docNode: stmt, bodyNode: stmt });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      map.set(stmt.name.text, { docNode: stmt, bodyNode: stmt });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          // docNode = the VariableStatement (holds JSDoc trivia), bodyNode = the declaration
          map.set(decl.name.text, { docNode: stmt, bodyNode: decl });
        }
      }
    }
  }
  return map;
}

function getBodyNode(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node)) return node.body ?? null;
  if (ts.isClassDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return init.body;
    }
  }
  return null;
}

function emptyBehavior(
  name: string,
  filePath: string,
  repo: string,
  docstring: string | null,
  isPure: boolean,
): SymbolBehavior {
  return {
    name, filePath, repo, docstring,
    hasIO: false, hasMutation: false, isPure,
    effectKinds: [], configKeysRead: [], featureFlagsRead: [], throwTypes: [],
  };
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractModuleDocstring(sf: ts.SourceFile): string | null {
  const text = sf.getFullText();
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(text);
  if (!match) return null;
  return cleanJsDoc(match[1]);
}

function extractDocstring(node: ts.Node, sf: ts.SourceFile): string | null {
  const fullText = node.getFullText(sf);
  const triviaWidth = node.getLeadingTriviaWidth(sf);
  const trivia = fullText.slice(0, triviaWidth);

  // Find the last JSDoc block in the leading trivia
  const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
  let match: RegExpExecArray | null;
  let lastMatch: string | null = null;
  while ((match = jsdocRegex.exec(trivia)) !== null) {
    lastMatch = match[1];
  }
  return lastMatch !== null ? cleanJsDoc(lastMatch) : null;
}

function cleanJsDoc(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => !line.startsWith('@') && line.length > 0);
  return lines.length > 0 ? lines.join('\n') : null;
}

// ─── process.env detection ────────────────────────────────────────────────────

function isProcessEnv(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    (expr.expression as ts.Identifier).text === 'process' &&
    expr.name.text === 'env'
  );
}

function extractEnvKeyFromPropAccess(expr: ts.PropertyAccessExpression): string | null {
  // process.env.KEY  →  expr.expression === process.env, expr.name === KEY
  if (ts.isPropertyAccessExpression(expr.expression) && isProcessEnv(expr.expression)) {
    return expr.name.text;
  }
  return null;
}

function extractEnvKeyFromElementAccess(expr: ts.ElementAccessExpression): string | null {
  // process.env['KEY']
  if (isProcessEnv(expr.expression) && ts.isStringLiteral(expr.argumentExpression)) {
    return expr.argumentExpression.text;
  }
  return null;
}

// ─── Config key detection ─────────────────────────────────────────────────────

const CONFIG_OBJ_NAMES = new Set(['config', 'Config', 'configuration', 'settings', 'cfg']);

function extractConfigGetKey(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (call.expression.name.text !== 'get') return null;
  if (!CONFIG_OBJ_NAMES.has(call.expression.expression.getText(sf))) return null;
  const firstArg = call.arguments[0];
  if (!firstArg || !ts.isStringLiteral(firstArg)) return null;
  return firstArg.text;
}

// ─── Feature flag detection ───────────────────────────────────────────────────

function detectFlag(
  call: ts.CallExpression,
  sf: ts.SourceFile,
  symbolName: string,
  filePath: string,
  repo: string,
): FlagDefinitionData | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const methodName = call.expression.name.text;

  let provider: FlagProvider | null = null;
  let checkKind: FlagCheckKind = 'is-enabled';

  for (const entry of FLAG_PATTERNS) {
    if (entry.methodNames.includes(methodName)) {
      provider = entry.provider;
      checkKind = entry.checkKind;
      break;
    }
  }

  // Fall back to generic detection for common method names
  if (!provider && GENERIC_FLAG_METHODS.has(methodName)) {
    provider = 'custom';
    checkKind = 'is-enabled';
  }

  if (!provider) return null;

  const firstArg = call.arguments[0];
  if (!firstArg || !ts.isStringLiteral(firstArg)) return null;

  return {
    name: firstArg.text,
    repo,
    filePath,
    symbolName,
    providerHint: provider,
    checkKind,
  };
}

// ─── Throw detection ──────────────────────────────────────────────────────────

function extractThrowType(stmt: ts.ThrowStatement, sf: ts.SourceFile): string | null {
  if (!stmt.expression) return 'Error';

  if (ts.isNewExpression(stmt.expression)) {
    const ctorText = stmt.expression.expression.getText(sf);
    return ctorText.split('.').pop() ?? 'Error';
  }

  if (ts.isIdentifier(stmt.expression)) {
    return stmt.expression.text;
  }

  if (ts.isCallExpression(stmt.expression)) {
    // throw createError(...) — surface the factory function name
    const calleeText = stmt.expression.expression.getText(sf);
    return calleeText.split('.').pop() ?? 'Error';
  }

  return 'Error';
}
