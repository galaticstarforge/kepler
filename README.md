# Kepler

Neo4j-backed code graph and markdown knowledge base with an MCP server for AI coding assistants.

## Quick Start

```bash
npm install -g @kepler/cli
kepler init
kepler deploy my-deployment
kepler tunnel
curl http://localhost:8080/health
```

## Prerequisites

- Node.js 20+
- AWS account with appropriate permissions
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

## Documentation

- [Getting Started](docs/getting-started.md) — Step-by-step first deployment guide
- [Architecture](docs/architecture.md) — System design and component overview
- [CLI Commands](docs/cli/commands.md) — Full command reference
- [Configuration](docs/configuration.md) — Config file schemas
- [Deployment](docs/deployment.md) — Infrastructure and sizing
- [Security](docs/security.md) — Security model and practices

## Packages

| Package | Description |
|---------|-------------|
| [@kepler/cli](packages/cli) | Command-line interface |
| [@kepler/core](packages/core) | Core runtime server |
| [@kepler/installer](packages/installer) | AWS CDK infrastructure |
| [@kepler/plugin-sdk](packages/plugin-sdk) | Plugin development SDK |
| [@kepler/shared](packages/shared) | Shared types and utilities |

## Multi-user Access

A second user can connect to an existing deployment:

```bash
npm install -g @kepler/cli
kepler discover
kepler tunnel
```

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

See [LICENSE.txt](LICENSE.txt).
