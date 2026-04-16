# Observability

I built this system to be debuggable. Every pass, every pipeline stage, and every MCP tool invocation is logged structurally and traceable end-to-end. This is not optional polish. It is a stated design principle. If something goes wrong during indexing or a query returns unexpected results, the system should be able to tell you exactly what happened.

---

## Logging

Structured JSON logs to standard output. Every log entry includes:

| Field | Notes |
|---|---|
| `timestamp` | ISO 8601 UTC |
| `level` | `debug`, `info`, `warn`, `error` |
| `component` | `orchestrator`, `mcp-server`, `enrichment`, etc. |
| `traceId` | When applicable, links to the originating request |
| `message` | Human-readable description |

Additional structured fields are included per event: `repo`, `pass`, `tool`, `durationMs`, and so on depending on context.

Log shipping is the operator's responsibility. CloudWatch Logs, Datadog, Loki, and others all ingest structured JSON natively without any adapter needed.

---

## Metrics

Prometheus-format metrics exposed on `/metrics` on a dedicated port (default: 9090).

### Core Metrics

| Metric | Type | Labels |
|---|---|---|
| `index_pass_duration_seconds` | histogram | `pass`, `incremental` |
| `index_pass_errors_total` | counter | `pass` |
| `graph_query_duration_seconds` | histogram | `query_name` |
| `mcp_request_duration_seconds` | histogram | `tool`, `status` |
| `mcp_rate_limit_hits_total` | counter | `token_name`, `tool` |
| `docs_enrichment_run_duration_seconds` | histogram | |
| `docs_store_operations_total` | counter | `operation`, `status` |
| `semantic_index_operations_total` | counter | `operation`, `status` |
| `repo_index_last_success_timestamp` | gauge | `repo` |
| `repo_index_last_failure_timestamp` | gauge | `repo` |

Plugin authors may register additional metrics via a core-provided registry.

---

## Tracing

OpenTelemetry-compatible tracing. Every MCP request creates a root span. Downstream graph queries, document reads, and pass invocations are child spans. Trace IDs are propagated through `traceparent` headers when applicable.

Default exporter: OTLP to a configurable endpoint. Deployments without a tracing backend can disable tracing entirely. The instrumentation overhead is negligible when exporters are no-ops.

```yaml
observability:
  tracing:
    enabled: true
    endpoint: http://otel-collector:4317
    samplingRate: 1.0        # 1.0 = trace everything
```

---

## Health Checks

The MCP server exposes three HTTP endpoints:

- `GET /health`: Liveness check. Returns 200 if the process is running.
- `GET /ready`: Readiness check. Returns 200 only when Neo4j, the document store, and the semantic index are all reachable.
- `GET /metrics`: Prometheus metrics.

The orchestrator and enrichment-cron expose `/health` and `/metrics` only. They do not have a `/ready` endpoint because they are not request-serving processes. They either run or they don't.

These endpoints are what load balancers and container orchestrators use to make routing decisions. Keep them fast. They should not do any work beyond a lightweight connectivity probe.
