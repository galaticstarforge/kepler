# Kepler: Design Overview

**Status:** Draft v1
**Scope:** OSS core project
**Audience:** Project maintainers and future plugin authors

This document covers what Kepler is, what it is not, and the principles it is built around. The rest of the docs are organized as follows:

- [Architecture](./architecture.md): Component map, responsibilities, and data flow.
- [Primitives](./primitives/): The shared node/edge vocabulary for code, cloud, and knowledge.
- [Storage Layer](./storage.md): Graph store, document store, semantic index, and source access.
- [Documentation System](./documentation-system.md): Store hierarchy, frontmatter schema, templates, and the `.claude/` prefix.
- [Doc Enrichment Cron](./doc-enrichment.md): Bidirectional linking between documents and the code graph.
- [MCP Server](./mcp-server.md): Transport, auth, rate limiting, and the full tool surface.
- [Enriched Graph Layer](./graph/): Structural metrics, behavioral extraction, and semantic enrichment.
- [Agentic Summarization](./summarization/): The summarization subsystem that populates summary nodes.
- [Deployment](./deployment.md): Host composition, instance sizing, networking, and secrets.
- [Configuration](./configuration.md): Main config file, repo config, and plugin config.
- [Observability](./observability.md): Logging, metrics, tracing, and health checks.
- [Security](./security.md): Threat model and controls.
- [CLI](./cli/): The `kepler` command-line tool: deployment, connectivity, commands, and internals.
- [Migration Guide](./migration.md): Step-by-step migration to the enriched graph and summarization layers.
- [Architecture Decision Records](./adrs/): Key decisions and their rationale.

---

## What This Is

Kepler is a self-hostable knowledge system that combines three things into one coherent tool:

1. **Code graph construction.** Parse source repositories into a typed property graph stored in Neo4j. The graph captures syntactic structure, references, scopes, data flow hints, and framework-level semantics.
2. **Documentation management.** Markdown-based documentation stored in S3 (or any S3-compatible backend) with structured frontmatter, served through a filesystem-like interface and indexed for semantic search.
3. **Machine-accessible interface.** A Model Context Protocol (MCP) server that exposes both the code graph and the documentation store to AI coding assistants. This is what makes retrieval-augmented workflows possible. Generated code and prose are grounded in the actual architecture of the target system.

I think the most important thing to understand about the design intent here is that this system is built to be driven primarily by AI coding assistants that both consume the knowledge and contribute back to it. They document decisions, update changelogs, and propose architectural changes as they work. The system is the connective tissue between what the code actually does and what any assistant trying to work with it needs to know.

---

## What This Is Not

Being specific about scope is important here. There are several things this system deliberately does not do.

**Not a security analysis tool.** Deep data-flow analysis (taint tracking, vulnerability detection) is out of scope. Plugins can integrate external tools like Joern for that, but the core system does not try to be a SAST scanner.

**Not a code search tool.** Full-text code search is already solved by tools like ripgrep and Sourcegraph. Kepler answers structural questions ("what calls this function," "what services publish to this queue"), not "find this string."

**Not a CI or linting tool.** Kepler observes code. It does not gate merges, block commits, or enforce policy. Observation and enforcement are different problems.

**Not multi-tenant.** A single deployment serves a single organization. Multi-tenancy would require reworking auth, storage isolation, and graph scoping. That is a future problem.

**Not a real-time collaborative editor.** Documentation edits flow through S3, not through a live WebSocket protocol. This is a deliberate simplicity tradeoff.

---

## Design Principles

These seven principles drive every architectural decision in the system. When something feels wrong about a design, it is usually because one of these is being violated.

### 1. Primitives over specifics

The core defines generic, language- and cloud-agnostic primitives. Language, framework, and cloud specifics live in plugins. The v1 primitive vocabulary is shaped to fit a known use case but named generically so it can evolve. If it is specific to JavaScript or to AWS, it belongs in a plugin, not in core.

### 2. Plugins extend at two points only

File reading and graph enrichment. No lifecycle hooks, no internal AST access, no monkey-patching. Keeping the extension surface narrow is the only realistic way to maintain a stable contract with plugin authors.

### 3. Graph as the integration surface

Plugins communicate with each other exclusively through the graph. No direct imports between plugin packages, no shared memory, no event bus. If one plugin needs something from another plugin, it reads from the graph that the other plugin wrote to.

### 4. Incremental by construction

Every component that processes files must declare how it invalidates on change. Full re-analysis exists as a fallback, but it is not the default path. Systems that require a full rebuild on every change do not scale to large codebases.

### 5. Schema-validated extensibility

Plugin node and edge types are declared upfront and validated for conflicts at registration time. Runtime schema drift is not possible. This is what keeps multiple plugins from silently overwriting each other's data.

### 6. Zero plugins, still useful

The core system with no plugins installed must produce a valuable graph and a functional MCP server against any JavaScript codebase. Plugins add depth. They do not provide baseline utility. This principle is what keeps the plugin architecture honest. If the core is not useful on its own, the primitives are not well-designed.

### 7. Observability as a first-class feature

Every pass, every pipeline stage, every MCP tool invocation is logged structurally and is traceable end-to-end. Debugging a graph extraction problem should not require guessing. The system should be able to tell you exactly what happened, in what order, and what the outcome was.
