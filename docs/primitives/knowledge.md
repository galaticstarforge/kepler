# Knowledge Primitives

Knowledge primitives are the connective tissue between code, cloud, and documentation. They do not describe source code structure, and they do not describe infrastructure. They describe the relationships between those things and the human-authored context sitting alongside them.

---

## Nodes

### `Document`

A markdown document in the documentation store. Every doc has structured frontmatter that drives the properties here. The `type`, `status`, `domain`, and `service` fields are what make the doc corpus queryable at the level of architecture: not just text search, but "show me all current ADRs for the auth service."

| Property | Type | Notes |
|---|---|---|
| `path` | string | Path within the document store (e.g., S3 key) |
| `title` | string | From frontmatter |
| `type` | string | From frontmatter `type` field |
| `status` | string | `current`, `draft`, `deprecated`, `proposed` |
| `author` | string | `human`, `claude-code`, or a specific identifier |
| `domain` | string | Business or architectural domain |
| `service` | string | Associated service, if any |
| `tags` | string[] | |
| `lastUpdated` | datetime | |
| `hash` | string | Content hash |

---

### `Concept`

A domain concept extracted from code, comments, or documentation. Concept nodes are created by the semantic enrichment pass, not by the base extractor. They represent recurring named ideas across the codebase: things like "retry budget," "ownership chain," "shadow record."

The point of concept nodes is to make implicit shared vocabulary explicit in the graph. When the same term shows up in a comment, a doc, and a symbol name, that is a signal worth capturing.

| Property | Type | Notes |
|---|---|---|
| `name` | string | Canonical concept name |
| `aliases` | string[] | Alternate spellings or synonyms |
| `domain` | string | Business domain, if scoped |

---

## Edges

| Edge | From | To | Notes |
|---|---|---|---|
| `DOCUMENTED_BY` | (any node) | Document | A code or cloud item has associated documentation |
| `REFERENCES` | Document | (any node) | A document explicitly mentions a specific entity |
| `MENTIONS` | Comment | Concept | A comment uses a recognized concept name |
| `RELATES_TO` | Document | Document | Derived from the frontmatter `related` field |
| `SUPERSEDES` | Document | Document | Version chain: the newer doc replaces the older one |

The `DOCUMENTED_BY` and `REFERENCES` edges together are what make bidirectional traversal possible. Starting from a `ComputeUnit`, you can follow `DOCUMENTED_BY` to find its docs. Starting from a `Document`, you can follow `REFERENCES` to find every code or cloud entity it talks about.
