# CLI (`@kepler/cli`)

**Status:** Draft v1
**Scope:** The `kepler` command-line interface
**Audience:** Project maintainers and contributors to the CLI

The `kepler` CLI is the sole supported interface for deploying, managing, upgrading, and connecting to a Kepler installation. This section of the docs covers the CLI specifically. For how the deployed runtime works, see the [core design docs](../README.md).

The CLI is the control plane. The deployed EC2 stack is the data plane. These docs do not describe the runtime's internal behavior, the plugin interface's semantic contract, or the MCP tool surface. Those are in the core docs.

---

## What the CLI Does

A user installs the CLI, runs a handful of commands, and ends up with:

- A provisioned EC2-based stack in their AWS account.
- Local connectivity to that stack via an SSM port-forwarding tunnel.
- The ability to upload and enable plugins.
- The ability to update, inspect, and destroy their deployment.

The CLI also handles onboarding for additional users. Given appropriate AWS IAM permissions, a second user on a different machine can discover an existing deployment and connect to it within minutes, without any out-of-band sharing of keys or credentials.

---

## What the CLI Does Not Do

**Not a runtime config editor.** The CLI manages the deployment envelope: instance size, VPC strategy, plugins enabled. It does not manage internal runtime configuration like pass parameters, Neo4j memory tuning, or MCP rate limits. Those are edited on the instance directly, or via explicit runtime-config commands added later.

**Not a graph query tool.** Users query the graph through the MCP server. The CLI never issues Cypher.

**Not a documentation editor.** Markdown lives in S3 and is edited via the MCP server or a separate tool. The CLI does not implement document CRUD.

**Not multi-cloud in v1.** AWS-only. The command vocabulary is cloud-agnostic (`deploy`, `tunnel`, `destroy`) so future providers can be added, but v1 ships only the AWS implementation.

**Not a CI/CD tool.** The CLI is designed for interactive human use. Automation is possible via `--json` output and non-interactive flags, but the primary UX is a human at a terminal.

---

## Design Principles

### 1. IAM is the only access control

The CLI does not implement its own auth, does not manage SSH keys, and does not maintain an invite list. Whoever has the right AWS IAM permissions can use the deployment. Whoever doesn't, can't. This is the entire security model.

### 2. No secrets on disk

The CLI stores no private keys, no tokens, no passwords. The only local state is a pointer to the S3 state bucket.

### 3. Declarative-by-default, imperative when needed

Deployment is declarative via CloudFormation. Runtime operations (tunnel, ssh, logs) are imperative because they're inherently interactive.

### 4. Auto-discovery over explicit configuration

When a user could reasonably expect the CLI to figure something out (which state bucket, which deployment, which region), the CLI tries to figure it out before prompting.

### 5. Every command works with `--json`

Human output is the default; machine output is always available. No command is human-only.

### 6. Fail loudly with actionable errors

Every error names what went wrong and what the user can do about it. Generic stack traces are a bug.

### 7. Idempotent where possible

Running `deploy` twice with the same config produces the same result. Running `init` twice is a no-op. Running `plugin enable` on an already-enabled plugin succeeds silently.

### 8. Version-pinned runtime

The CLI version determines the runtime version that gets deployed. No tag-chasing, no surprise upgrades.

---

## Document Map

- [Distribution and Installation](./distribution.md): npm package, prerequisites, platform support, offline behavior.
- [State Model](./state.md): Local state file, remote S3 state bucket, and auto-discovery.
- [Deployment Model](./deployment.md): Tiers, VPC strategies, what gets provisioned, CloudFormation, and the runtime image.
- [Connectivity](./connectivity.md): Why SSM, the access model, tunnel lifecycle, and shell access.
- [Commands](./commands.md): Full command reference with flags, behavior, and output.
- [Internal Architecture](./internals.md): Package layout, command dispatch, AWS clients, CDK integration, dependencies, and testing.
- [Security](./security.md): Credentials, audit, attack surface, and CloudFormation permission scoping.
- [Versioning and Compatibility](./versioning.md): Semver policy, runtime pinning, upgrade path, and downgrade behavior.
