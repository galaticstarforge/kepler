export type SymbolKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'parameter'
  | 'property'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'interface';

export type ScopeKind = 'function' | 'block' | 'module' | 'global';

export type ExportKind = 'default' | 'named' | 'namespace';

export type Mutability = 'const' | 'let' | 'var' | 'readonly';

export type ModuleSystem = 'commonjs' | 'esm' | 'amd' | 'iife' | 'none' | 'mixed';

export type ResolutionStatus = 'exact' | 'inferred' | 'heuristic' | 'unresolved';

export interface ModuleData {
  repo: string;
  path: string;
  language: string;
  dialect: string;
  hash: string;
  loc: number;
  hasSideEffects: boolean;
  isBarrel: boolean;
  moduleSystem: ModuleSystem;
}

export interface SymbolData {
  name: string;
  kind: SymbolKind;
  scopeKind: ScopeKind;
  isExported: boolean;
  exportKind: ExportKind | null;
  isAsync: boolean;
  isGenerator: boolean;
  mutability: Mutability | null;
  lineStart: number;
  lineEnd: number;
  signature: string;
  repo: string;
  filePath: string;
}

export interface ExternalPackageData {
  name: string;
}

export interface CallSiteData {
  calleeExpression: string;
  argumentCount: number;
  isNewExpression: boolean;
  line: number;
  resolutionStatus: ResolutionStatus;
  repo: string;
  filePath: string;
}

export type ScopeNodeKind = 'module' | 'function' | 'block' | 'iife' | 'catch' | 'with';

export interface ScopeData {
  repo: string;
  filePath: string;
  kind: ScopeNodeKind;
  lineStart: number;
  lineEnd: number;
  isStrict: boolean;
  /** Stable identifier within the file — used to attach children. */
  id: string;
  parentId: string | null;
}

export type CommentKind = 'line' | 'block' | 'jsdoc' | 'license' | 'shebang';

export interface CommentData {
  repo: string;
  filePath: string;
  kind: CommentKind;
  text: string;
  lineStart: number;
  lineEnd: number;
  hasDocTags: boolean;
}

export type ReferenceBindingKind = 'static' | 'dynamic' | 'computed';
export type ReferenceConfidence = 'exact' | 'inferred' | 'heuristic' | 'unresolved';

export interface ReferenceData {
  repo: string;
  filePath: string;
  name: string;
  bindingKind: ReferenceBindingKind;
  isRead: boolean;
  isWrite: boolean;
  isCall: boolean;
  line: number;
  column: number;
  confidence: ReferenceConfidence;
}

export interface ImportsEdgeProps {
  kind: 'value' | 'type' | 'namespace';
  specifiers: string[];
  line: number;
}

export interface ExportsEdgeProps {
  exportName: string;
  isDefault: boolean;
}

export interface ExtractionResult {
  module: ModuleData;
  symbols: SymbolData[];
  externalPackages: ExternalPackageData[];
  localImports: Array<{
    targetPath: string;
    props: ImportsEdgeProps;
  }>;
  callSites: CallSiteData[];
  exports: Array<{
    symbolName: string;
    props: ExportsEdgeProps;
  }>;
  scopes: ScopeData[];
  comments: CommentData[];
  references: ReferenceData[];
}

// ─── Behavioral extraction types ─────────────────────────────────────────────

export type EffectKind =
  | 'file-read'
  | 'file-write'
  | 'network-call'
  | 'db-read'
  | 'db-write'
  | 'env-read'
  | 'process-spawn'
  | 'timer'
  | 'dom-mutation';

export type FlagProvider = 'launchdarkly' | 'unleash' | 'growthbook' | 'custom';
export type FlagCheckKind = 'is-enabled' | 'variant' | 'kill-switch';
export type ServiceProtocol = 'http' | 'grpc' | 'amqp' | 'graphql';
export type ServiceDetectionMethod = 'sdk-import' | 'url-pattern' | 'client-constructor';

export interface SymbolBehavior {
  name: string;
  filePath: string;
  repo: string;
  docstring: string | null;
  hasIO: boolean;
  hasMutation: boolean;
  isPure: boolean;
  effectKinds: EffectKind[];
  configKeysRead: string[];
  featureFlagsRead: string[];
  throwTypes: string[];
  catches: CatchClauseInfo[];
  /** Services this symbol references via imported SDKs. */
  serviceCalls: string[];
}

export interface CatchClauseInfo {
  /** Error type the catch clause targets, or `Error` / `unknown` as a fallback. */
  errorType: string;
  /** Raw catch body text, truncated to 200 chars. */
  catchBlock: string;
}

export interface FlagDefinitionData {
  name: string;
  repo: string;
  filePath: string;
  symbolName: string;
  providerHint: FlagProvider;
  checkKind: FlagCheckKind;
}

export interface ExternalServiceData {
  name: string;
  repo: string;
  filePath: string;
  symbolName: string | null;
  protocol: ServiceProtocol;
  detectionMethod: ServiceDetectionMethod;
}

export interface BehavioralResult {
  moduleDocstring: string | null;
  symbolBehaviors: SymbolBehavior[];
  flags: FlagDefinitionData[];
  externalServices: ExternalServiceData[];
}
