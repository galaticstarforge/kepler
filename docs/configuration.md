# Configuration

The system is configured via a main YAML file and a separate per-repo descriptor file. Both files are mounted read-only into all containers at `/etc/project/`. I kept this setup deliberately simple: two files, well-defined schemas, no runtime config mutation.

---

## Main Configuration File

Path: `/etc/project/config.yaml`

```yaml
# System-wide settings.
system:
  name: my-deployment
  environment: production    # production | staging | development

# Storage backends.
storage:
  graph:
    bolt: bolt://neo4j:7687
    username: neo4j
    password: ${secret:neo4j-password}
  documents:
    provider: s3             # s3 | filesystem
    bucket: my-docs-bucket
    prefix: docs/
    region: us-east-1
  semanticIndex:
    provider: bedrock        # bedrock | pgvector | sqlite
    knowledgeBaseId: abc123
    region: us-east-1

# Source repository access.
sourceAccess:
  cloneRoot: /var/repos
  fetchIntervalSeconds: 60
  sshKeyPath: /root/.ssh/id_ed25519

# Orchestrator behavior.
orchestrator:
  pollIntervalSeconds: 300
  maxConcurrentPasses: 4
  passTimeoutSeconds: 300
  passFailurePolicy: continue    # continue | abort-cycle

# Base extractor configuration.
baseExtractor:
  javascript:
    parseJsx: true
    parseTypeScript: true
    includeNodeModules: false

# Enrichment cron.
enrichment:
  scheduleMinutes: 30
  relatedCodeSection: true
  conceptExtraction:
    enabled: false

# MCP server.
mcp:
  transport: sse             # sse | stdio
  port: 8080
  rateLimits:
    defaults:
      requestsPerMinute: 60
      requestsPerHour: 500

# Observability.
observability:
  logLevel: info             # debug | info | warn | error
  metrics:
    enabled: true
    port: 9090
  tracing:
    enabled: false
    endpoint: http://otel-collector:4317

# Plugins to load, in order.
plugins:
  - name: '@kepler/plugin-serverless'
    config:
      frameworkVersion: 2
  - name: '@kepler/plugin-aurelia'
```

---

## Repository Configuration

Path: `/etc/project/repos.yaml`

This file defines the set of repositories to index.

```yaml
defaults:
  branch: main
  cloneDepth: 0              # 0 = full history
  ignorePatterns:
    - node_modules/**
    - .serverless/**
    - dist/**
    - coverage/**

repos:
  - name: my-service
    url: git@github.com:my-org/my-service.git
    branch: main             # overrides default

  - name: my-frontend
    url: git@github.com:my-org/my-frontend.git
    branch: develop
    ignorePatterns:
      - node_modules/**
      - build/**
      - public/assets/**
```

---

## Plugin Configuration

Per-plugin configuration nests under the `plugins` section of the main config. Each plugin declares its own JSON Schema, and the orchestrator validates the config block against that schema at registration time.

Plugins that fail validation do not load. The orchestrator continues without them and logs the failure. This is intentional. A misconfigured plugin should not prevent the rest of the system from starting.

Plugin authors should document their config schema alongside the plugin. The schema is also introspectable via `admin.pluginStatus` once the system is running.
