# Primitives

Primitives are the shared vocabulary between core, plugins, and the MCP server. They are declared in the core package and validated at plugin registration. Every node type and edge type a plugin introduces has to be declared upfront and checked for conflicts before the plugin is allowed to register. I think this is the right constraint to put on plugins early, because schema conflicts at runtime would be silent and nearly impossible to debug.

There are three groups:

- **[Code](./code.md)**: Source code structure and references. Produced by the base JS extractor and language plugins.
- **[Cloud](./cloud.md)**: Infrastructure, deployment, and runtime topology. Produced entirely by plugins; the core does not extract any of these.
- **[Knowledge](./knowledge.md)**: Connective tissue between code, cloud, and documentation. Produced by the semantic enrichment pass.

All three groups share the same graph. An edge from a `ComputeUnit` to a `Symbol` (via `IMPLEMENTED_BY`) crosses the cloud/code boundary. An edge from a `Symbol` to a `Document` (via `DOCUMENTED_BY`) crosses the code/knowledge boundary. The graph does not enforce separation between groups. That is intentional. The value of a unified graph is exactly that you can traverse across those boundaries.
