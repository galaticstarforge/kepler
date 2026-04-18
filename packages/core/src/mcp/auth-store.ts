import type { AuthConfig, AuthTokenConfig } from '../config.js';

/** Maps tool-name prefix → required scope. */
const TOOL_SCOPE_MAP: Record<string, string> = {
  'docs.create': 'docs:write',
  'docs.read': 'docs:read',
  'docs.update': 'docs:write',
  'docs.delete': 'docs:write',
  'docs.list': 'docs:read',
  'docs.search': 'docs:read',
  'docs.propose': 'docs:write',
  'docs.listTemplates': 'docs:read',
  'docs.applyTemplate': 'docs:write',
  'concepts.list': 'docs:read',
  'concepts.read': 'docs:read',
  'graph.query': 'graph:read',
  'graph.findSymbol': 'graph:read',
  'graph.symbolDetails': 'graph:read',
  'graph.callers': 'graph:read',
  'graph.callees': 'graph:read',
  'graph.impactOf': 'graph:read',
  'graph.relatedDocs': 'graph:read',
  'graph.symbolsInDoc': 'graph:read',
  'graph.moduleGraph': 'graph:read',
  'graph.listServices': 'graph:read',
  'graph.serviceTopology': 'graph:read',
  'graph.semanticSearch': 'graph:read',
  'graph.symbolContext': 'graph:read',
  'graph.communityContext': 'graph:read',
};

export interface ValidatedToken {
  name: string;
  scopes: string[];
}

interface CacheEntry {
  token: AuthTokenConfig;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

export class AuthStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  /** Returns null when auth is disabled — callers treat null as "all scopes granted". */
  get enabled(): boolean {
    return this.config.enabled;
  }

  validate(bearerToken: string): ValidatedToken | null {
    const now = Date.now();

    const cached = this.cache.get(bearerToken);
    if (cached && cached.expiresAt > now) {
      return { name: cached.token.name, scopes: cached.token.scopes };
    }

    const found = this.config.tokens.find((t) => t.token === bearerToken);
    if (!found) return null;

    this.cache.set(bearerToken, { token: found, expiresAt: now + CACHE_TTL_MS });
    return { name: found.name, scopes: found.scopes };
  }

  /** Returns null if the tool is public (no scope requirement known). */
  static requiredScopeFor(toolName: string): string | null {
    if (toolName.startsWith('admin.')) return 'admin:*';
    return TOOL_SCOPE_MAP[toolName] ?? null;
  }

  static hasScope(grantedScopes: string[], requiredScope: string): boolean {
    if (grantedScopes.includes('admin:*')) return true;
    if (grantedScopes.includes(requiredScope)) return true;
    // graph:write implies graph:read; docs:write implies docs:read
    if (requiredScope === 'graph:read' && grantedScopes.includes('graph:write')) return true;
    if (requiredScope === 'docs:read' && grantedScopes.includes('docs:write')) return true;
    return false;
  }
}
