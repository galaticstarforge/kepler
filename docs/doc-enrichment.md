# Doc Enrichment Cron

The enrichment cron is a scheduled job that maintains bidirectional linking between documents and the code graph. It runs independently of the orchestrator and can be scheduled more conservatively. The typical cadence is every 30 to 60 minutes. I designed it this way because code changes faster than documentation, and running enrichment on every commit would be wasted work. It does not need to run on every code change; it runs on a cadence that keeps the doc corpus reasonably fresh.

---

## Responsibilities

1. Walk the document store, identify documents changed since the last run, and process them.
2. For each changed document, extract symbol references and graph-entity references from the prose.
3. Resolve those references against the graph and produce `REFERENCES` edges from `Document` to matched entities.
4. Update each document's "Related Code" section (if enabled) with current links.
5. Optionally invoke an LLM to extract domain concepts and create `Concept` and `MENTIONS` relationships.
6. Reconcile `DOCUMENTED_BY` edges: every entry in a document's `symbols:` frontmatter produces an explicit edge; every resolved prose reference produces one with lower confidence.
7. Emit a summary of changes for the run.

---

## Reference Extraction

For each document's markdown body, the cron extracts candidate references through four channels, in order of decreasing confidence:

1. **Explicit frontmatter `symbols:` field.** Already structured. Resolved directly.
2. **Inline code spans containing identifiers.** Any `` `camelCaseIdentifier` `` or `` `PascalCaseIdentifier` `` is a candidate. Filtered against common-word stoplists.
3. **Fenced code block imports.** Lines matching `require('./x')` or `import { y } from './z'` inside a code block. Path resolution uses the document's service context from frontmatter to disambiguate.
4. **Explicit link syntax.** `[text](graph://symbol/<repo>/<path>#<symbol-name>)`, a custom URL scheme the system recognizes and resolves directly.

Resolution then proceeds against the graph with this precedence:

1. Exact match on `(repo, filePath, symbolName)` using frontmatter-derived service context.
2. Exact match on `(repo, symbolName)` where frontmatter specifies a service.
3. Fuzzy match on symbol name within the same domain (via `Document.domain` and the `Symbol → repo → service → domain` traversal).
4. Repo-wide fuzzy match with a confidence threshold; below threshold, the reference is dropped.

Unresolved references are recorded but do not produce edges. A summary of unresolved candidates is included in the run output to surface documentation gaps. This is intentional. A list of things that didn't resolve is actually useful signal about where the doc corpus is out of date.

---

## "Related Code" Section

When enabled (via per-document frontmatter or global config), the cron appends or updates a `## Related Code` section at the end of each document. The section is auto-generated and delimited by HTML comments so the cron can replace it in place without disturbing manual edits.

```markdown
<!-- enrichment:related-code:begin -->
## Related Code

- `handlePayment()`: [payment-gateway/src/handlers/payment.js:42](graph://symbol/payment-gateway/src/handlers/payment.js#handlePayment)
- `PaymentRequest`: [shared-schemas/payments.js:15](graph://symbol/shared-schemas/payments.js#PaymentRequest)

_Last updated: 2026-04-16T09:30:00Z_
<!-- enrichment:related-code:end -->
```

Anything outside the delimiters is preserved on update. If a document author removes the delimiters, the cron respects that and does not re-inject the section.

---

## Concept Extraction (Optional)

Concept extraction is an opt-in pass that uses an LLM to identify domain concepts mentioned in documents and comments. For each document (and optionally each `Comment` node above a length threshold), the LLM is prompted to extract named domain concepts. Those concepts are deduplicated across the corpus. Similar names are merged via embedding proximity and stored as `Concept` nodes, then linked via `MENTIONS` edges.

This is what makes queries like "find all documentation about fraud detection" work even when the phrase "fraud detection" doesn't appear verbatim. The documents that discuss the concept under various names are discoverable through the `Concept` node.

Enable it in the main config:

```yaml
enrichment:
  conceptExtraction:
    enabled: true
    provider: bedrock          # bedrock | openai | ollama
    model: amazon.titan-text-lite-v1
    minCommentLength: 200
```

---

## Scheduling and Idempotency

The cron is driven by a standard scheduler (cron-style on the host, or an EventBridge rule on AWS). Runs are idempotent. Re-running against an unchanged corpus produces no graph changes and no document writes.

State tracking:
- **Per-document:** `lastEnrichedHash` is stored as a property on the `Document` node. If the hash hasn't changed, the document is skipped.
- **Per-run:** runs are recorded with timestamps, a changes summary, and cost consumption if LLM calls were made. This data is available via the `admin.enrichmentRun` MCP tool.
