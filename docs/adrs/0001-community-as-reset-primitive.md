# ADR-0001: Community Detection as the Summarization Reset Primitive

**Status:** Accepted  
**Date:** 2026-04-16

---

## Context

Agentic code summarization operates within a context window. When the context window fills, the agent must write what it knows, reset, and continue with a new window. The question is what the reset boundary should be.

Four candidates:

1. **File boundary.** Reset after each file. Simple to implement. Fails for any project where a logical unit of work spans multiple files (most of them).
2. **Module boundary.** Reset after each `Module` node. Better than files if module granularity is meaningful. For projects with large modules, context still overflows; for projects with unusually small modules, context is mostly context setup overhead per reset.
3. **Call depth.** Reset after expanding N hops from a starting symbol. Deterministic. Produces context windows that contain the full call chain down to depth N. Misses lateral relationships: symbols that are architecturally co-located but don't directly call each other.
4. **Community boundary.** Reset at the community boundary produced by the structural metrics pass (Leiden community detection on the `CALLS` graph). The community is the set of symbols that call each other more than they call symbols in other communities. This is exactly the set of symbols whose context is mutually informative.

The community boundary naturally sizes context windows because community detection algorithms produce communities of bounded size by construction for typical codebases. It also produces conceptual coherence: community members are usually co-located in the domain model, so the resulting summaries will use consistent terminology within a community.

---

## Decision

Use community boundaries as the primary reset primitive for the summarization agent.

The agent processes one community at a time. Within a community, it expands context up to the configured token budget. When the budget is consumed or the community is complete, it writes its summaries and marks the community done. It does not carry summarization state across community boundaries.

Secondary reset signals within a community:
- Budget pressure: if the running token count exceeds 80% of the community's budget before all focal symbols are covered, the agent switches to shorter provisional summaries for the remaining symbols.
- Layer crossing: if expanding a callee would require crossing into a symbol in a different architectural layer, the agent substitutes the callee's existing `SymbolSummary` (if present) rather than reading the source.
- Depth limit: the agent will not expand callers or callees beyond 4 hops from the focal symbol during a single community pass.

---

## Consequences

### What This Enables

- Context sent to the model is coherent by construction: the symbols in a single context window tend to share domain concepts, naming conventions, and control flow.
- Community summaries (`CommunitySummary` nodes) are a natural byproduct: after summarizing all symbols in a community, the agent has enough context to write a community-level summary at low marginal cost.
- Incremental updates are community-scoped: a change to any symbol in a community only re-queues that community, not the entire codebase.
- Parallelism is community-scoped: two agents can safely work on different communities simultaneously without coordination beyond a lock on the community being processed.

### What This Costs

- Requires the structural metrics pass to have run and produced community assignments before summarization can begin. If the graph has no community assignments, the summarization subsystem cannot operate.
- Community boundaries are not guaranteed to be semantically meaningful for all codebases. Projects with flat or deep call graphs may produce communities that are large, noisy, or arbitrary. The quality of summaries depends on the quality of community detection.
- Community re-detection after large refactors may reassign many symbols to new communities, invalidating existing summaries even for unchanged symbols. The 20% membership-shift threshold for staleness is a heuristic; communities that just barely cross it will cause unnecessary re-summarization.

### Failure Modes

- A community with 200+ symbols will exceed the token budget even at the most aggressive compression. The agent will produce provisional summaries for most symbols and flag the community for an upgrade pass. This is expected; there is a configuration override to allow processing oversized communities in multiple passes.
- If GDS community detection fails or produces a single community covering 80% of the codebase (pathological for dense call graphs), the summarization subsystem degrades gracefully by routing all symbols through that one "community" with aggressive provisional-only treatment.

---

## Alternatives Considered

**File boundary:** rejected because files are a storage artifact, not an architectural boundary. Two files in the same module are architecturally closer than two files in different modules, but a file-boundary agent treats them identically.

**Module boundary:** acceptable for codebases with well-structured modules, but module boundaries are manually maintained and often don't reflect actual runtime coupling. Community detection is derived from actual call relationships.

**Call depth:** produces context windows that are deep but not broad. Good for understanding a single execution path; not good for understanding the architectural role of a symbol or its co-evolution with peers.
