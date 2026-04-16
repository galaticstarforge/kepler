# Security

This document covers the threat model for the system and the controls that address it. The system is not a public-facing product. It is an internal tool for a single organization, so the threat model is scoped accordingly. I think being explicit about what we trust and what we don't is more useful than a generic security posture statement, so that's what this document does.

---

## Threat Model

### Assumed Trusted

- The host operating system and network fabric.
- The Neo4j instance (not exposed externally; inter-container communication only).
- Git repositories (their content is treated as trusted input for parsing).

### Assumed Untrusted

- **MCP clients.** Authenticated but assumed potentially compromised. A token with `docs:read` and `graph:read` scope should not be able to modify anything, regardless of what the client sends.
- **Plugin code.** Reviewed before installation but sandboxed at runtime to the extent practical. In v1, plugins run in the same process as the orchestrator, which is a known limitation. Plugins are expected to be reviewed and installed intentionally.
- **Document content.** Claude Code may generate document content. Treat any content sourced from an AI assistant as untrusted input to downstream rendering. Rendering isolation (see below) is the control here.

---

## Controls

### Token-Scoped Access

MCP tokens are scoped to the minimum required capabilities. A read-only research client receives only `docs:read` and `graph:read`. A token cannot escalate its own scopes. Scope validation happens before any handler logic runs.

### Cypher Injection Prevention

`graph.query` accepts only parameterized Cypher. User input cannot influence query structure, only query parameters. The server inspects the query string before execution and rejects any `CREATE`, `MERGE`, `SET`, `DELETE`, or `REMOVE` present regardless of where they appear in the string.

### Markdown Rendering Isolation

When the system renders markdown for the semantic index or for any UI surface, rendering occurs in a sandboxed process with no network or filesystem access. This prevents malicious content in AI-generated documents from reaching any system resource through a rendering vulnerability.

### Plugin Isolation

In v1, plugins run in the same process as the orchestrator. This is a known limitation. The mitigation is that plugins are reviewed before installation and there is no plugin registry that allows arbitrary third-party plugins to be loaded without explicit operator action. A future version will isolate plugins via worker threads or subprocesses.

### Secrets Never in Logs

The logging framework includes a scrubbing layer that redacts known secret patterns (tokens, passwords, AWS credentials). Log sampling is used in development mode; strict redaction is enforced in production. This means you cannot accidentally expose a bearer token by logging a request object.

### No Static AWS Credentials

The system assumes an IAM role attached to the EC2 instance for all AWS API calls. Static credentials in config files or environment variables are not supported and should not be used. This eliminates the credential rotation problem and prevents credentials from appearing in config files, environment dumps, or container logs.
