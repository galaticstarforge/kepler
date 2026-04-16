# Agent Tool Surface

The summarization agent operates through a narrow, purpose-built tool surface. It does not have access to general file system tools, bash execution, or the full MCP server tool surface available to end users. The narrow surface serves two purposes: it prevents the agent from going off-script, and it makes the agent's behavior auditable and reproducible.

Every tool call is logged with the trace ID of the current summarization run. The full tool call history for any run is available via `admin.summarizationRunHistory`.

---

## Read Tools

### `get_community(communityId: string): CommunityResult`

Returns the community metadata and a ranked list of its members.

```typescript
interface CommunityResult {
  communityId: number;
  repo: string;
  size: number;
  cohesion: number;
  members: SymbolStub[];  // sorted by pageRank descending
}

interface SymbolStub {
  symbolId: string;       // repo:filePath#symbolName
  name: string;
  kind: string;
  communityRole: string;  // core | boundary | bridge
  pageRank: number;
  fanIn: number;
  isPublicApi: boolean;
  docstring: string | null;
  hasSummary: boolean;
  summaryTier: 'provisional' | 'canonical' | null;
}
```

### `get_node(symbolId: string): SymbolDetail`

Returns full detail for a single symbol.

```typescript
interface SymbolDetail {
  symbolId: string;
  name: string;
  kind: string;
  signature: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isPublicApi: boolean;
  isPure: boolean;
  hasIO: boolean;
  hasMutation: boolean;
  effectKinds: string[];
  configKeysRead: string[];
  featureFlagsRead: string[];
  semanticTags: string[];     // from existing DocAnnotation or prior summary
  docstring: string | null;
  architecturalLayer: string;
  boundedContextId: string | null;
  communityId: number;
  communityRole: string;
  pageRank: number;
  changeFrequency: number;
  authorCount: number;
  // Behavioral edges summary
  throwsTypes: string[];      // error type names from THROWS edges
  externalServices: string[]; // from CALLS_SERVICE edges
  testCoverage: boolean;      // has any TEST_ASSERTS incoming edge
}
```

### `get_existing_summary(symbolId: string): ExistingSummary | null`

Returns the existing summary for a symbol, or null if none exists. This is how the agent reads provisional summaries of dependencies before generating canonical summaries for the focal set.

```typescript
interface ExistingSummary {
  purpose: string;
  details: string | null;
  sideEffects: string | null;
  semanticTags: string[];
  tier: 'provisional' | 'canonical';
  isStale: boolean;
  generatedAt: string;  // ISO 8601
}
```

### `expand_callers(symbolId: string, depth?: number, crossCommunityOnly?: boolean): SymbolStub[]`

Returns callers of the given symbol, up to `depth` hops (default: 1). When `crossCommunityOnly = true`, filters to callers outside the symbol's community.

### `expand_callees(symbolId: string, depth?: number, crossCommunityOnly?: boolean): SymbolStub[]`

Returns callees of the given symbol. Same parameters as `expand_callers`.

### `read_file_range(filePath: string, lineStart: number, lineEnd: number): string`

Returns the raw source text for the given range. Line numbers are 1-indexed and inclusive. The agent uses this to read symbol implementations directly before writing canonical summaries. Maximum range: 500 lines per call.

This tool reads from the bare git clone on the host filesystem via `SourceAccess`, the same interface used by the base extractor.

---

## Write Tools

### `write_summary(target: SummaryTarget, payload: SummaryPayload): void`

Writes a summary to the graph. The tool validates the payload structure before writing and runs the assertion validation loop described in [agent-loop.md](./agent-loop.md).

```typescript
type SummaryTarget =
  | { kind: 'symbol'; symbolId: string }
  | { kind: 'community'; communityId: number; repo: string };

interface SummaryPayload {
  purpose: string;          // Required. Max 150 chars.
  details?: string;         // Canonical only. Max 600 chars.
  sideEffects?: string;     // Max 300 chars. Omit if null.
  semanticTags: string[];   // Required. 1-10 tags.
  examplesFromTests?: string; // Canonical only when testCoverage is true.
  tier: 'provisional' | 'canonical';
  coverageFlags: string[];
  // Structured assertions for validation:
  assertions?: {
    calls?: string[];       // symbol names this function calls
    throws?: string[];      // error type names
    reads_config?: string[]; // config key names
  };
  // Community-only fields:
  name?: string;            // for CommunitySummary; required when target.kind = 'community'
  externalDependencies?: string[];
}
```

The `assertions` field drives the validation loop. If `assertions` is present, the tool cross-checks each claim against the graph before committing. On failure it returns a `ValidationResult` and the agent must retry or omit the failing assertion.

### `mark_cluster_complete(communityId: number, repo: string, coveragePct: number): void`

Records that the agent has finished processing a community. Updates the `Community` node's `lastSummarizedAt` and `coveragePct` properties. Releases the coordination lock so other agents cannot re-process the same community.

`coveragePct` is the agent's self-reported fraction of community members that received a summary in this pass. The tool validates this against the actual graph state and records the lower of the two values.

---

## Navigation Tools

### `list_pending_communities(repo: string): CommunityStub[]`

Returns communities that are unsummarized or stale, sorted by priority score.

```typescript
interface CommunityStub {
  communityId: number;
  size: number;
  priorityScore: number;
  hasSummary: boolean;
  summaryAge: number | null;  // days since last canonical summary
}
```

### `get_coverage_report(repo: string): CoverageReport`

Returns current coverage statistics. The agent uses this at the start of a run to understand what needs to be done.

```typescript
interface CoverageReport {
  totalSymbols: number;
  symbolsWithCanonical: number;
  symbolsWithProvisional: number;
  symbolsUnsummarized: number;
  staleCanonical: number;
  totalCommunities: number;
  communitiesWithSummary: number;
  estimatedCostToComplete: number;  // rough token estimate
}
```

---

## What the Agent Does Not Have Access To

The agent cannot:
- Execute arbitrary Cypher (`graph.query` is not in the agent's tool surface)
- Access the documentation store (`docs.*` tools are not available)
- Run shell commands or access the filesystem directly (all source reads go through `read_file_range`)
- Access credentials, environment variables, or configuration files
- Call any external service directly (all external calls go through logged tool calls)

This restriction is intentional. A generic tool surface for an LLM agent is a security and cost risk. The narrow surface also makes the agent's behavior auditable: any `read_file_range` call references a specific file path and line range that is logged and attributable to a specific community pass.
