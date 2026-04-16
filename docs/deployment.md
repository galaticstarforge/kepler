# Deployment

This system deploys to a single host: an EC2 instance for production, any Docker-capable host for development. Multi-host deployments are possible but not a v1 target. I think the single-host model is the right call for v1 because it eliminates a whole category of distributed-system complexity that would otherwise dominate the operational story.

---

## Host Composition

```
┌──────────────────────────────────────────────────────────────┐
│  EC2 Instance (recommended: m7i.xlarge or m7i.2xlarge)       │
│                                                              │
│  Docker Compose services:                                    │
│                                                              │
│    ┌─────────────────────────────────────────────────────┐   │
│    │  mcp-server           (container)                   │   │
│    │  - Exposes SSE on 8080 internally                   │   │
│    │  - Reads from Neo4j, DocumentStore, SemanticIndex   │   │
│    └─────────────────────────────────────────────────────┘   │
│                                                              │
│    ┌─────────────────────────────────────────────────────┐   │
│    │  orchestrator         (container)                   │   │
│    │  - Runs extraction pipeline                         │   │
│    │  - Git watcher polls repos                          │   │
│    │  - Writes to Neo4j                                  │   │
│    └─────────────────────────────────────────────────────┘   │
│                                                              │
│    ┌─────────────────────────────────────────────────────┐   │
│    │  enrichment-cron      (container)                   │   │
│    │  - Scheduled doc enrichment                         │   │
│    │  - Reads DocumentStore + Neo4j                      │   │
│    │  - Writes back to DocumentStore                     │   │
│    └─────────────────────────────────────────────────────┘   │
│                                                              │
│    ┌─────────────────────────────────────────────────────┐   │
│    │  neo4j                (container, Neo4j CE 5)       │   │
│    │  - Bolt on 7687                                     │   │
│    │  - Browser UI on 7474 (dev only, disabled in prod)  │   │
│    └─────────────────────────────────────────────────────┘   │
│                                                              │
│  Volumes:                                                    │
│    - neo4j-data        (persistent; backup to S3)            │
│    - neo4j-logs                                              │
│    - repo-clones       (shared read-only mount into          │
│                         orchestrator and mcp-server)         │
│    - config            (read-only mount into all containers) │
│                                                              │
│  External services:                                          │
│    - S3 (document store)                                     │
│    - Bedrock KB (semantic index)                             │
│    - Secrets Manager (tokens, Neo4j credentials)             │
└──────────────────────────────────────────────────────────────┘
```

---

## Instance Sizing

**Minimum viable: m7i.xlarge** (4 vCPU, 16 GB RAM). Supports roughly 100 repositories of around 500 files each.

**Recommended for the initial internal deployment: m7i.2xlarge** (8 vCPU, 32 GB RAM). This gives headroom for Neo4j page cache growth, concurrent pass execution, and simultaneous MCP requests.

**Storage: EBS gp3, 200 GB minimum.** The breakdown:
- Bare clones: 40-80 GB for 100 repos, depending on history depth and LFS usage.
- Neo4j data: 20-60 GB depending on graph size. Grows with enrichment passes.
- Neo4j logs: 5 GB with log rotation.
- System and containers: 30 GB.
- Headroom: 30+ GB.

These are estimates. A codebase with deep git history or many large binary files in LFS will use more clone storage. A graph with many enrichment passes run against large repos will use more Neo4j storage. Monitor actual usage after the first week and size accordingly.

---

## Networking

The MCP server is never exposed directly to the internet. Three fronting options:

1. **API Gateway HTTP API + VPC link** (recommended for AWS). TLS termination, WAF, and IP allowlisting at the gateway level.
2. **Application Load Balancer** with TLS certificates from ACM. IP allowlisting via security group rules.
3. **Cloudflare Tunnel** for non-AWS deployments. Adequate for single-user scenarios.

The Neo4j browser UI (port 7474) is bound to localhost only in production. Developer access goes through SSH port forwarding.

---

## Secrets Management

Four categories of secrets:

1. **Neo4j admin password.** Rotated manually. Injected via Docker secret.
2. **MCP bearer tokens.** Multiple tokens with scopes. Stored in AWS Secrets Manager (or environment variables in development).
3. **Git SSH keys for repo access.** Deploy keys, one per repo or a shared read-only key. Mounted read-only into the orchestrator.
4. **AWS credentials.** IAM role attached to the EC2 instance. No static credentials.

Static AWS credentials should never appear in config files or environment variable blocks in Docker Compose. The EC2 instance role is the right mechanism. It handles credential rotation automatically and does not require any credential management on the application side.

---

## Docker Compose Skeleton

```yaml
services:
  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: none
      NEO4J_server_memory_heap_initial__size: 4g
      NEO4J_server_memory_heap_max__size: 8g
      NEO4J_server_memory_pagecache_size: 8g
    volumes:
      - neo4j-data:/data
      - neo4j-logs:/logs
    ports:
      - "127.0.0.1:7687:7687"
      - "127.0.0.1:7474:7474"  # dev only

  orchestrator:
    image: kepler-orchestrator:latest
    depends_on: [neo4j]
    volumes:
      - repo-clones:/var/repos
      - ./config:/etc/project:ro
    secrets:
      - neo4j-password
      - ssh-keys

  mcp-server:
    image: kepler-mcp-server:latest
    depends_on: [neo4j]
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - repo-clones:/var/repos:ro
      - ./config:/etc/project:ro
    secrets:
      - neo4j-password

  enrichment-cron:
    image: kepler-enrichment-cron:latest
    depends_on: [neo4j]
    volumes:
      - ./config:/etc/project:ro
    secrets:
      - neo4j-password

volumes:
  neo4j-data:
  neo4j-logs:
  repo-clones:

secrets:
  neo4j-password:
    external: true
  ssh-keys:
    external: true
```
