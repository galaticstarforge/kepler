# Cost and Quality

The agentic summarization subsystem is the most expensive part of Kepler to run. The structural and behavioral extraction passes are cheap: graph algorithms and static analysis, no LLM calls. The summarization pass involves LLM inference for every community in the codebase. For a large codebase with 500 communities and average 25 symbols each, a full first pass might cost $80-120 at current model pricing. That is not a lot in absolute terms, but it is surprising if you didn't know it was coming.

I think the right posture is to be explicit about cost, make it controllable, and make subsequent runs dramatically cheaper than the first.

---

## Model Selection

Two model tiers:

**Navigation model:** used for planning, priority decisions, and generating provisional summaries. Should be fast and cheap. I recommend `claude-3-5-haiku` or `gpt-4o-mini`. Typical input: 2-4K tokens. Typical output: 100-300 tokens.

**Summary model:** used for generating canonical summaries. Should be high-quality. I recommend `claude-3-5-sonnet` or `gpt-4o`. Typical input: 8-15K tokens (community context, focal symbol source, callers/callees, docstrings). Typical output: 300-700 tokens.

Both are configurable in `config.yaml`:

```yaml
summarization:
  navigationModel: anthropic.claude-3-5-haiku-20241022
  summaryModel: anthropic.claude-3-5-sonnet-20241022
  embeddingModel: amazon.titan-embed-text-v2:0   # 1536 dimensions
  provider: bedrock    # bedrock | openai | ollama
```

The embedding call is separate from the summary generation call. Embeddings are requested in batches of 100 after writing summaries, not per-symbol. This keeps embedding costs low and makes the embedding step fail independently of the summary step.

---

## Per-Cluster Budgets

Each community has a hard token budget. If the agent approaches the budget before finishing the community, it writes provisional summaries for the remaining focal symbols and marks the community for a follow-up upgrade pass.

Budget defaults:

| Community Size | Input Token Budget | Output Token Budget |
|---|---|---|
| < 20 symbols | 8,000 | 2,000 |
| 20-50 symbols | 15,000 | 4,000 |
| > 50 symbols | 25,000 | 6,000 |

These are configurable. The defaults are conservative for the summary model; adjust up if summary quality is unsatisfactory on large communities and cost is not a constraint.

The agent tracks a running token count via the tool call response metadata. When the running count exceeds 80% of the budget, it stops expanding context and moves to the writing phase.

---

## Tiered Summary Quality

Not every symbol deserves the same investment. The priority function steers the agent toward important symbols, but within a community, further prioritization is needed.

**Tier-1 symbols (canonical with full context):** top-10 by pageRank, all bridge symbols, all `isPublicApi = true` symbols. These get the summary model and full community context.

**Tier-2 symbols (canonical with reduced context):** remaining symbols in the focal set. These get the summary model but with a shorter context window: only the symbol's own source, its docstring, and a brief community overview. No caller/callee expansion.

**Tier-3 symbols (provisional):** symbols not in the focal set. These get the navigation model, no source read, and a one-sentence summary derived from the docstring (if present) or a structural inference from the symbol's properties (`kind`, `isPublicApi`, `effectKinds`, etc.).

This tiering can produce summaries of noticeably different quality for different symbols. That is okay. The `tier` and `coverageFlags` fields on `SymbolSummary` expose this for consumers. The MCP server signals tier in its responses.

---

## Cost Estimation

Before starting a summarization pass, the agent can call `get_coverage_report` to get a rough cost estimate. The estimate is based on:

```
estimated_input_tokens = (unsummarized_communities * avg_community_size * avg_tokens_per_symbol_context)
estimated_output_tokens = (unsummarized_communities * avg_community_size * avg_tokens_per_summary)
estimated_cost = (input_tokens / 1M * input_price) + (output_tokens / 1M * output_price)
```

The estimate is displayed in `admin.summarizationCoverage` output and as a confirmation prompt when triggering a full pass via `admin.triggerSummarization`. The user can set a hard cost ceiling in the config:

```yaml
summarization:
  maxRunCostUSD: 50.00    # Abort the pass if this ceiling would be exceeded
```

If a run is projected to exceed the ceiling, it runs in priority order until the ceiling is hit, then stops. Partial coverage is always better than no coverage.

---

## Coverage Tracking

Coverage is tracked at the symbol, community, and repo levels. The following metrics are available via `admin.summarizationCoverage`:

```json
{
  "repo": "payment-gateway",
  "totalSymbols": 4821,
  "canonical": 2104,
  "provisional": 891,
  "unsummarized": 1826,
  "stale": 312,
  "canonicalPct": 43.6,
  "totalCommunities": 47,
  "communitiesComplete": 28,
  "communitiesPartial": 11,
  "communitiesUntouched": 8,
  "lastRunAt": "2026-04-16T09:00:00Z",
  "lastRunCostUSD": 12.40
}
```

Coverage metrics are also exposed as Prometheus gauges:

```
kepler_summarization_canonical_pct{repo="payment-gateway"} 43.6
kepler_summarization_stale_count{repo="payment-gateway"} 312
kepler_summarization_last_run_cost_usd{repo="payment-gateway"} 12.40
```

---

## Incremental Updates

After the initial full pass, subsequent runs are incremental. A symbol needs re-summarization when:

1. `Symbol.hash != SymbolSummary.contentHash` (the source changed)
2. The symbol's `communityId` changed (community partition shifted)
3. The `SymbolSummary.tier = 'provisional'` and the symbol's priority score has risen above the canonical threshold (upgrade eligible)
4. The `promptVersion` stored on the summary does not match the current prompt version

The incremental pass collects into community batches the set of symbols that need re-summarization. Only communities with at least one member needing re-summarization are re-queued. This dramatically reduces the cost of routine incremental runs: a day's worth of code changes typically affects 1-5% of symbols, which means 1-5% of the batch re-summarization cost.

**Git hook integration:** the orchestrator can be configured to trigger an incremental summarization pass after each indexing run that changes above a threshold. This is disabled by default because it can create cost surprises if commits are frequent. The recommended setup is a scheduled nightly pass:

```yaml
summarization:
  schedule: '0 2 * * *'   # 2 AM nightly
  incremental: true        # only re-summarize changed/stale symbols
  maxRunCostUSD: 20.00
```

---

## Parallelization

See [agent-loop.md](./agent-loop.md) for the parallelization design. The cost and quality implications:

**Cost:** parallel agents do not share provisional summaries generated mid-run. Agent A may generate a provisional summary for an external symbol that agent B will also need, and both agents will spend tokens generating it. This is a duplicate cost. For typical parallelism of 2-4 agents, the duplication is small relative to the speedup. At higher parallelism it can be meaningful. The coordination mechanism could be extended to share provisional summaries across agents; this is not in v1.

**Quality:** agents processing communities in parallel produce summaries that are consistent within each community but may use slightly different terminology across communities. This is acceptable. The `CommunitySummary` for each community is generated in the context of that community's work, not in a global context, so conceptual drift is expected and bounded by community size.

---

## Failure Modes and Mitigations

**Cost surprise on first run.** The initial full pass over a large codebase is the most expensive run. Users who trigger it without reviewing the cost estimate will be surprised. Mitigation: always show the estimate and require confirmation. The `maxRunCostUSD` ceiling provides a hard stop.

**Summary drift.** Summaries generated months apart in the same codebase may use inconsistent terminology. The semantic tags help but don't fully solve this. Mitigation: the upgrade pass regenerates provisional summaries with awareness of existing canonical summaries in the community, which pulls terminology toward consistency. A future improvement would be a "terminology normalization" pass that clusters semanticTags across the codebase and proposes a canonical vocabulary.

**Model output instability.** LLMs are not deterministic even with `temperature=0` in practice. The same symbol can get different summaries on different runs. Mitigation: treat summaries as approximations, not facts. The `contentHash` and `promptVersion` fields make it clear when a summary is regenerated, so downstream consumers can choose how to handle changes.

**Validation false positives.** The assertion validator can flag a legitimate call as a mismatch because the graph's call resolution is `heuristic` rather than `exact`. Mitigation: for assertions where the graph's `CALLS` edge has `confidence = 'heuristic'`, validation is lenient and does not trigger a retry. The `validationStatus` field records the actual confidence of the validating edge.

**Coverage gaps in rarely-called code.** Dead code, deprecated utilities, and rarely-used library helpers have low pageRank and low fan-in. They will be deprioritized by the priority function and may never receive canonical summaries. This is by design. If coverage of low-importance code matters, the `minSymbolPageRank` filter in `config.yaml` can be set to 0 to force full coverage. Expect a substantial cost increase.
