# Agentic Summarization

The agentic summarization subsystem populates the `SymbolSummary` and `CommunitySummary` nodes described in [graph/semantic-enrichment.md](../graph/semantic-enrichment.md). It is a separate process from the orchestrator and from the doc enrichment cron. It runs on a slower cadence than both, because it is more expensive and because LLM-generated content does not need to be as fresh as structural graph data.

The core insight driving the design is that a coding agent reading an unfamiliar codebase already does something like what we want: it reads a cluster of related functions, builds up a working model of them, summarizes what it understood, and moves on to the next cluster. The difference is that we want to do this systematically, store the summaries in a queryable form, and never do it redundantly.

The community detection layer (see [graph/structural-metrics.md](../graph/structural-metrics.md)) gives us the clustering for free. Community boundaries are natural reset points for context. The graph gives us the traversal order. The narrow tool surface (described in [tool-surface.md](./tool-surface.md)) prevents the agent from going off-script.

---

## Design Documents

- [Agent Loop](./agent-loop.md): Frontier-driven planning, the cluster traversal loop, reset signals, two-tier provisional/canonical summaries, and the validation cycle.
- [Tool Surface](./tool-surface.md): The narrow MCP-style tool surface the summarization agent operates through, distinct from the end-user MCP tool surface.
- [Cost and Quality](./cost-and-quality.md): Model selection, per-cluster budgets, coverage tracking, staleness handling, incremental updates, and parallelization.

---

## What This Is Not

This is not RAG over code. The existing Kepler graph already handles structural retrieval well. The summarization layer fills the gap for conceptual questions that structural retrieval cannot answer: "what does this function actually do," "what concept does this cluster of code implement," "what is the codebase's understanding of retry-safe operations."

This is also not a one-shot embedding pass over every function in the codebase. One-shot passes produce uniform, low-context summaries. The agentic approach produces higher-quality summaries because the agent reads each symbol in the context of its community: it knows what the callers do, what the callees do, and what the cluster is collectively trying to accomplish.

The cost is higher than a one-shot pass. The quality is substantially better for the symbols that matter most. The cost discipline mechanisms in [cost-and-quality.md](./cost-and-quality.md) address how to make this tractable.

---

## Relationship to the Rest of Kepler

The agentic summarization subsystem consumes the graph (reads `Symbol`, `Community`, `CallSite`, `TEST_ASSERTS`, `SymbolSummary` nodes) and writes to it (`SymbolSummary`, `CommunitySummary`, coverage metadata). It operates entirely through the narrow tool surface and does not make direct Neo4j connections. All graph reads and writes go through MCP-style tool calls that enforce the same auth and rate-limiting constraints as external calls.

The summarization pass does not modify any base extraction output. It only writes to the semantic enrichment layer. If the summarization pass is turned off or its output is deleted, the graph reverts to the state described by the structural and behavioral layers.
