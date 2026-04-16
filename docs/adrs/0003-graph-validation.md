# ADR-0003: Graph Validation as the Summary Quality Mechanism

**Status:** Accepted  
**Date:** 2026-04-16

---

## Context

LLMs hallucinate. When asked to summarize a function, a model may confidently assert that the function calls a method that does not exist in the codebase, or that it raises an exception it does not raise, or that it is used as a constructor when it is actually used as a factory. These hallucinations are plausible-sounding and hard to catch by reading the summary in isolation.

Several approaches to quality assurance:

1. **Human review.** Have a developer verify each canonical summary. Sets the highest quality floor. Completely impractical at scale; negates the purpose of automated summarization.
2. **LLM self-critique.** Ask the same or a different model to critique the summary. Catches some logical inconsistencies. Does not catch factual errors about the specific codebase (a critic that doesn't have the source can't tell you the function doesn't actually call `stripe.charge`).
3. **Heuristic rules.** Parse the summary for symbol names and check they exist in the graph. Catches null-reference hallucinations. Misses behavioral claims ("this function is idempotent") that are unverifiable by name lookup alone.
4. **Graph validation loop.** Ask the model to produce structured assertions alongside the summary, then query the graph to verify those assertions. Combines structural knowledge (what the graph knows for certain) with LLM output (what the model claims). Mismatches trigger a single correction attempt.

Graph validation is the best available automated mechanism. It does not achieve human-review quality, but it catches a class of hallucinations that are particularly damaging for developer tool use cases: wrong callees, wrong exception types, wrong config key names. These are the claims most likely to send a developer down the wrong path.

---

## Decision

I use a structured assertion-and-validation loop for canonical summaries. Provisional summaries are not validated.

**Assertion extraction:** the canonical summary prompt includes a section asking the model to produce structured assertions in a separate `assertions` field in its JSON response:

```json
{
  "assertions": [
    { "kind": "calls", "target": "stripe.PaymentIntent.create" },
    { "kind": "throws", "target": "PaymentDeclinedError" },
    { "kind": "reads_config", "key": "stripe.apiKey" }
  ]
}
```

**Cypher verification:** each assertion is translated to a Cypher query. For `calls` assertions, the agent checks for a `CALLS` or `CALLS_SERVICE` edge from the focal symbol. For `throws` assertions, it checks for a `THROWS` edge. For `reads_config`, it checks for a `READS_CONFIG` edge.

**Retry on mismatch:** if any assertion is not supported by the graph, the agent sends a single correction prompt containing the graph's actual outbound edges and asks for a corrected summary. The correction uses the same model as the original.

**Validation status:** the `SymbolSummary.validationStatus` field records one of `'validated' | 'partial' | 'unvalidated'`:
- `'validated'`: all assertions passed, or no assertions were made.
- `'partial'`: at least one assertion failed; the correction was accepted but one or more assertions remain unverified.
- `'unvalidated'`: validation was skipped (provisional tier, or validation tooling unavailable).

---

## Consequences

### What This Enables

- Factual hallucinations about callees, exceptions, and config keys are caught before the summary is written to the graph.
- The `validationStatus` field gives MCP consumers a confidence signal. Tools that generate code or refactoring plans can require `validationStatus: 'validated'` to avoid acting on hallucinated facts.
- The correction prompt provides a natural mechanism for the model to strengthen summaries with graph-confirmed facts: when told "the graph shows you also call `logger.warn` but you didn't mention it," the model often produces a better summary that acknowledges that call.
- Building an assertion format shared with the tool surface creates a reusable verification pattern that can be extended to behavioral claims when behavioral extraction data is available.

### What This Costs

- Validation adds approximately 40% more token usage per canonical summary: one generation call, plus the Cypher queries (minimal cost), plus one correction call when validation fails. For codebases where hallucination rates are low, this cost is partially wasted.
- The validation loop requires the behavioral and structural extraction passes to have been run, or at least the structural pass. A graph with no `THROWS` edges cannot validate `throws` assertions. Partial validation (checking what the graph knows) is acceptable; the `validationStatus: 'partial'` code handles this case.
- One correction retry is the limit. A model that produces incorrect assertions after seeing the graph's ground truth will produce a summary marked `'partial'` rather than triggering a second retry. Unlimited retries would multiply cost. In practice, the correction prompt rarely produces a second-generation mismatch because the model is given the explicit graph evidence.

### Failure Modes

- **Graph resolution is heuristic.** The `CALLS` edges in Kepler's graph have a `confidence` property (`'exact' | 'heuristic'`). If the model asserts a call that appears in the graph but only with `confidence: 'heuristic'`, the validation passes but may be false. Assertions verified only via heuristic edges are recorded with `confidence: 'heuristic'` in the validation result.
- **Missing edges due to incomplete analysis.** If the parser did not extract a `THROWS` edge because the throw was inside a dynamically-constructed error, the validation will fail the `throws` assertion even though it is correct. The correction prompt tells the model the graph did not find the edge, which may cause the model to remove the assertion. This is a false negative.
- **Assertion scope creep.** If the model makes 20+ assertions, the Cypher verification step becomes expensive and slow. The prompt template limits assertions to 10 per summary. Assertions beyond the limit are not verified and do not appear in the validation result.

---

## Alternatives Considered

**Human review:** not feasible at scale. Considered as a fallback for summaries with `validationStatus: 'partial'`; this is a reasonable future addition for high-stakes production codebases, but not in v1.

**LLM self-critique:** tested during design. Catches some logical incoherence but does not reliably catch factual errors about the specific codebase. A critic model that hasn't read the source will agree with a plausible-sounding hallucination.

**Heuristic rules (name lookup only):** simpler than a full validation loop. Catches the most egregious hallucinations (non-existent symbol names) but misses behavioral claims. A developer who acts on a behavioral claim ("this function is idempotent") that the graph could have refuted has been given misinformation. Name lookup alone is insufficient.
