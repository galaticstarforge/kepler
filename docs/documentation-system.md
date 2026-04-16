# Documentation System

The documentation system is the second major half of this project alongside the code graph. It owns the structured markdown corpus, the templates, the frontmatter schema, and the bidirectional linking between docs and the graph. The goal is a doc corpus that an AI assistant can navigate by structure, not just by full-text search. I think the frontmatter schema is the key to making that work: without typed, queryable metadata, you end up with a pile of markdown files that's only searchable by keyword.

---

## Document Store Hierarchy

This is the canonical layout. All paths are relative to the configured root (typically an S3 key prefix).

```
docs-root/
│
├── _meta/
│   ├── CONVENTIONS.md          # Human-authored conventions document
│   ├── SERVICE_REGISTRY.md     # Master index of services and ownership
│   └── templates/
│       ├── adr.md
│       ├── runbook.md
│       ├── service-readme.md
│       ├── app-readme.md
│       ├── incident.md
│       ├── postmortem.md
│       └── changelog-entry.md
│
├── platform/
│   ├── architecture/
│   │   ├── system-overview.md
│   │   ├── adrs/
│   │   │   └── {NNNN}-{slug}.md
│   │   ├── patterns/
│   │   └── diagrams/
│   ├── infrastructure/
│   ├── data/
│   ├── security/
│   ├── observability/
│   ├── ci-cd/
│   └── standards/
│
├── domains/
│   └── {domain-name}/
│       ├── overview.md
│       ├── glossary.md
│       ├── service-map.md
│       └── data-flows.md
│
├── services/
│   └── {service-name}/
│       ├── README.md
│       ├── api/
│       ├── adrs/
│       ├── runbooks/
│       ├── changelog.md
│       └── guides/
│
├── apps/
│   └── {app-name}/
│       ├── README.md
│       ├── architecture/
│       ├── features/
│       ├── adrs/
│       ├── changelog.md
│       └── guides/
│
├── operations/
│   ├── incidents/
│   ├── postmortems/
│   └── runbooks/
│
└── .claude/
    ├── sessions/
    ├── proposals/
    └── scratchpad/
```

Enforcement of this hierarchy is advisory, not strict. Writes to arbitrary paths succeed. The system derives structure from frontmatter when the path is non-canonical. This layout is recommended because it aligns with the default templates, the doc enrichment cron's heuristics, and the bucket structure that Bedrock KB chunks against. Following it isn't required. Ignoring it means less is automatic.

---

## Frontmatter Schema

Every document should declare YAML frontmatter at the top of the file. Frontmatter is parsed on every document write. Validation failures are logged but do not block writes. Drafting a document with incomplete frontmatter is a supported workflow. Documents with invalid frontmatter appear in the graph as `Document` nodes with reduced metadata.

```yaml
---
title: string                    # Required. Human-readable title.
type: string                     # Required. One of the document types below.
status: string                   # Required. current | draft | deprecated | proposed
author: string                   # Required. human | claude-code | <identifier>
created: date                    # Required. ISO 8601 date.
updated: date                    # Required. ISO 8601 date.
domain: string                   # Optional. Business domain.
service: string                  # Optional. Associated service name.
app: string                      # Optional. Associated app name.
tags: string[]                   # Optional. Free-form tags.
related:                         # Optional. Paths or symbol references.
  - path: string
symbols:                         # Optional. Explicit graph symbol bindings.
  - repo: string
    path: string
    name: string
supersedes: string               # Optional. Path of document this replaces.
confluence_sync: boolean         # Optional. If false, exclude from external sync.
---
```

### Document Types

| Type | Description |
|---|---|
| `adr` | Architecture Decision Record |
| `runbook` | Operational procedure |
| `guide` | Tutorial or how-to |
| `overview` | Introductory description of a service, domain, or app |
| `reference` | Authoritative reference (API, schema, conventions) |
| `changelog` | Rolling log of changes |
| `incident` | Incident report |
| `postmortem` | Post-incident analysis |
| `api` | API contract description |
| `schema` | Data schema documentation |
| `pattern` | Reusable architectural or code pattern |
| `glossary` | Domain vocabulary |
| `service-map` | Map of service relationships within a domain |

---

## Document Templates

Templates live under `_meta/templates/` and are authored in markdown with frontmatter already populated as far as possible. Placeholders use `{{double-curly}}` syntax.

**Example: `_meta/templates/adr.md`**

```markdown
---
title: "{{NNNN}} - {{Title}}"
type: adr
status: proposed
author: {{author}}
created: {{date}}
updated: {{date}}
tags: []
---

# {{NNNN}} - {{Title}}

## Status

Proposed

## Context

What is the issue motivating this decision?

## Decision

What change are we proposing or have agreed to implement?

## Consequences

What becomes easier or harder as a result of this change?

## Alternatives Considered

What other options were evaluated and why were they rejected?
```

Templates ship with the core package and are copied to the document store on first orchestrator run. Plugin-contributed templates are written on plugin registration. Templates are replaced on version updates; local modifications to shipped templates are preserved in a `_meta/templates/.overrides/` prefix.

---

## The `.claude/` Prefix

The `.claude/` prefix is reserved for AI-assistant activity and is excluded from the canonical document tree.

- **`sessions/`**: Per-session summaries auto-generated by Claude Code after significant work. Not indexed into semantic search by default.
- **`proposals/`**: Draft documents proposed by Claude Code, awaiting human review. Indexed into semantic search but filtered by default when `author: claude-code` + `status: proposed`.
- **`scratchpad/`**: Ephemeral working notes. Excluded from indexing entirely.

This is what makes a clean workflow possible where Claude Code documents as it works without polluting the canonical doc tree until a human promotes the content. The MCP server's `docs.propose` tool writes here by default. `docs.create` writes to the canonical tree.

---

## Content Types and Rendering

Documents stored in the document store are raw markdown. Rendering is the consumer's responsibility.

- The MCP server returns raw markdown in `docs.read` responses; clients render if needed.
- The semantic index receives rendered text (markdown stripped to plain text) for embedding.
- An optional static site build target produces HTML for internal publishing, but that is not part of the MCP data path.

Non-markdown files (YAML schemas, diagrams as PNG/SVG, attachment binaries) are permitted. They are tracked as `Document` nodes with `type: attachment` and are not indexed into semantic search. `REFERENCED_BY` edges connect them to documents that include them.
