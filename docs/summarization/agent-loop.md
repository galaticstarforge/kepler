# Agent Loop

This document describes the planning and execution logic of the summarization agent: how it decides what to summarize next, how it processes a cluster, what causes it to reset context, and how it handles the two-tier provisional/canonical distinction.

---

## Frontier-Driven Planning

The agent maintains a priority queue of communities to process. This queue is seeded at the start of each summarization run and is deterministic given the same graph state: same seed produces the same traversal order, which means runs are reproducible and debugging is tractable.

**Priority function for communities:**

```
priority(community) =
    w1 * avg(member.pageRank)              // structural importance
  + w2 * avg(member.fanIn)                 // how much of the codebase depends on this
  + w3 * fraction(members with isPublicApi) // public surface exposure
  + w4 * avg(member.changeFrequency)        // volatility: high-churn clusters need fresh summaries
  - w5 * fraction(members with canonical_summary) // already covered: deprioritize
```

Default weights: `w1=0.4, w2=0.3, w3=0.2, w4=0.1, w5=1.0`. The heavy penalty for already-covered communities ensures the agent focuses on gaps rather than re-summarizing stable, well-covered code. Weights are configurable in the main `config.yaml` under `summarization.priorityWeights`.

The queue is a max-heap. The agent pops the highest-priority community, processes it fully, marks it as done, then pops the next. The queue state is persisted to S3 (under the deployment state bucket) so runs can be resumed after interruption.

**Seeding the queue:**

```python
# Pseudo-code
communities = graph.run("""
    MATCH (c:Community {repo: $repo})
    WHERE NOT exists {
        MATCH (c)<-[:HAS_COMMUNITY_SUMMARY]-(:CommunitySummary {tier: 'canonical'})
        WHERE summary.generatedAt > datetime() - duration('P30D')
    }
    RETURN c
""")

for community in communities:
    priority_queue.push(community, priority(community))
```

Communities with canonical summaries less than 30 days old are excluded from the initial queue. They can still be re-processed if their staleness flag is set.

---

## The Cluster-at-a-Time Loop

For each community popped from the queue:

### Step 1: Load community context

```
tools: get_community(communityId)
       get_node(symbolId) × N        // one per member, in pageRank order
       get_existing_summary(symbolId) × K  // for any that already have summaries
```

The agent reads the community metadata and the top members by pageRank. For large communities (> 50 symbols), it reads only the top-20 by pageRank, plus all boundary and bridge symbols. Remaining symbols in oversized communities get provisional summaries generated with reduced context.

### Step 2: Identify dependencies (external context)

For each boundary/bridge symbol, read provisional summaries of up to 5 of its cross-community callees: the symbols it calls that live in other communities. This gives the agent one layer of outward context without loading the entire codebase.

```
tools: expand_callees(symbolId, depth=1, cross_community_only=true) × boundary_symbols
       get_existing_summary(externalSymbolId) × external_symbols
```

If no `SymbolSummary` exists for an external dependency, the agent generates a **provisional summary** for it (see below) before continuing. This provisional summary is a side product of the main pass, generated at lower quality to bound context budget.

### Step 3: Read source for focal symbols

For the top-10 symbols by pageRank within the community (the "focal set"), read the actual source:

```
tools: read_file_range(filePath, lineStart, lineEnd) × focal_set
```

The agent does not read source for every symbol in the community. Bridge and boundary symbols that are mostly pass-through get summaries from contextual inference rather than direct source reading.

### Step 4: Summarize the community on egress

After reading all focal symbols, the agent generates summaries in batch, not incrementally. It does not write a summary after reading each symbol; it builds up an internal picture of the cluster and writes all summaries at once when done with the community. This is the "egress" framing: the act of writing summaries is what signals that the agent has finished understanding this cluster and is ready to move on.

This matters because incremental writing creates substantial low-quality partial context. A symbol read early in the pass has less context than one read late. Writing all summaries together ensures each one benefits from the full community picture.

```
tools: write_summary(symbolId, summaryPayload) × focal_set
       write_summary(communityId, communityPayload)
       mark_cluster_complete(communityId, coveragePct)
```

---

## Reset Signals

A "reset" means the agent clears its working context and starts fresh for a new cluster. The primary reset is the community boundary: finish a community, write summaries, clear context, pop next community.

Secondary reset signals that trigger an early exit from a community pass:

1. **Context budget pressure.** The running token count of the agent's context window exceeds 80% of the model's maximum. The agent summarizes what it has so far as provisional summaries, marks the community as partially processed, and moves to the next community. On a later pass it will complete the partially-processed community.

2. **Layer crossing.** When expanding dependencies reveals that a community straddles multiple architectural layers (e.g., half the symbols are in `service` layer, half in `repository`), the agent splits the community into virtual sub-clusters before summarizing. This is not a re-partition of the graph; it is a processing decision. The written summaries reference the layer context explicitly.

3. **Distance from any focal node.** If dependency expansion reaches symbols more than 4 hops from any focal symbol in the current community, expansion stops. This prevents rabbit holes where a community's external dependencies have their own deep dependency chains.

---

## Two-Tier Summaries: Provisional and Canonical

**Provisional summaries** are generated when a symbol needs to be understood as *context for something else*, not as the primary focus. They use a cheaper model, fewer input tokens, and a shorter output format. They are generated opportunistically during community passes.

Provisional summary format:
```json
{
  "purpose": "one sentence, max 120 chars",
  "semanticTags": ["tag1", "tag2"],
  "tier": "provisional"
}
```

**Canonical summaries** are generated when a symbol is part of the focal set for its community. They use the full model, full context, and the complete output format defined in the tool surface specification.

Canonical summary format:
```json
{
  "purpose": "one sentence",
  "details": "2-5 sentences",
  "sideEffects": "string or null",
  "semanticTags": ["..."],
  "examplesFromTests": "string or null",
  "tier": "canonical",
  "coverageFlags": ["docstring", "callers", "tests", ...]
}
```

**Upgrade pass:** after a first full traversal of all communities, symbols that received only provisional summaries can be upgraded in a second pass. The upgrade pass is cheaper because the community context is already established: the provisional summaries of the community's members serve as the context for upgrading each one to canonical.

The upgrade pass is optional and configurable. Small teams may never need it; large teams with high-traffic internal libraries will want it.

---

## Validation Loop

After the agent writes a summary, the orchestrator validates the emitted facts against the graph. The agent is prompted to include structured assertions in its output alongside the natural-language summary:

```json
{
  "purpose": "...",
  "assertions": {
    "calls": ["processCharge", "validateCard"],
    "throws": ["PaymentDeclinedError", "ValidationError"],
    "reads_config": ["STRIPE_API_KEY"]
  }
}
```

The orchestrator checks each assertion against the graph:
- For each item in `calls`: verify that a `CALLS` edge exists from the symbol to a symbol with that name.
- For each item in `throws`: verify that a `THROWS` edge exists (or a `throw` statement with that error type in the symbol's source).
- For each item in `reads_config`: verify that a `READS_CONFIG` edge exists or a `configKeysRead` property contains the key.

**On mismatch:** the orchestrator retries the summary generation once with the failing checks appended as a correction prompt:

```
Your previous summary included these claims that don't match the graph:
- You claimed this function calls 'processCharge', but no CALLS edge exists to that symbol.
Please review the source and revise.
```

After one retry, further retries are abandoned. The summary is saved with a `validationStatus: 'partial'` flag listing the unresolved assertions. These are surfaced in `admin.summarizationCoverage` output.

**False negative tolerance:** validation mismatches are not always errors. The graph's behavioral extraction may have missed a call due to dynamic dispatch, or the agent may have used a different name for the symbol. The validation is a quality signal, not a hard gate. A summary with one unresolved assertion is still useful.

---

## Parallelization

Multiple summarization agents can run in parallel on different communities. Community context is fully isolated: two agents processing different communities with no shared border symbols have zero context contamination. The priority queue is coordinated via an S3-backed lock: each agent claims a community by writing a lock entry before processing it, and releases it when done.

Agents should not be allowed to process communities that share boundary symbols simultaneously. The risk is that agent A generates a provisional summary for an external symbol that agent B is about to process canonically, causing agent B to use a lower-quality basis. The coordinator enforces this by checking whether any boundary symbol of a claimed community is currently being processed by another agent.

**Practical parallelism:** most runs will use 2-4 agents in parallel. The coordination overhead grows with parallelism; above 4 agents, the coordination cost starts to dominate for typical codebase sizes.

---

## Determinism and Reproducibility

The priority queue is seeded from a hash of the current graph state. Given the same graph, the traversal order is the same. This means:

- Debugging a bad summary is possible: you can reproduce the exact pass that generated it.
- A/B testing summary quality is possible: fix the seed, change the model, compare outputs.
- Coverage reports are comparable across runs.

The agent's prompt templates are also versioned. The version is stored on each `SymbolSummary` node as `promptVersion`. If prompt templates change, the orchestrator knows which summaries were generated with old prompts and can re-queue those communities for regeneration.
