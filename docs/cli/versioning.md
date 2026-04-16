# Versioning and Compatibility

## CLI Versioning

Semantic versioning. Major, minor, patch.

- **Major:** breaking changes to the command surface, state bucket schema, or deployment topology.
- **Minor:** new commands, new flags, new tier options, new plugin hooks exposed via CLI.
- **Patch:** bug fixes, documentation, non-breaking internal changes.

---

## Runtime Version Pinning

Each CLI version pins a specific runtime version. Installing `@kepler/cli@0.3.2` means deployments use `ghcr.io/<org>/kepler-core:0.3.2`. The pinning is embedded in the CDK stack templates.

I think this is the right approach. Tag-chasing `latest` would cause silent behavior changes across unrelated `deploy` invocations. Explicit pinning makes each `deploy` reproducible and debuggable. If something changes between runs, the CLI version is the reason.

---

## Upgrade Path

User upgrades follow a specific order:

1. Install a newer CLI: `npm install -g @kepler/cli@latest`.
2. Run `kepler upgrade` to confirm the new version is healthy and review what changed.
3. Run `kepler deploy <name>` to apply the new runtime version to the existing deployment. This triggers a CloudFormation update, restarts the container on the EC2 instance, and updates the version reported by `kepler status`.

For major-version upgrades, release notes detail required actions: plugin reuploads, state bucket migrations, etc. The CLI may refuse to upgrade a deployment across major boundaries without an explicit `--major-upgrade` flag.

---

## State Bucket Schema Versioning

`_meta/state-bucket-version.yaml` records the schema version in use. The CLI reads this on every state-bucket operation.

- If the installed CLI is newer than the bucket schema, it auto-migrates where safe.
- If the installed CLI is older than the bucket schema, it errors and instructs the user to upgrade the CLI.

This means the schema version is a one-way ratchet. You can always go forward; you cannot go back without a destroy-and-recreate.

---

## Downgrades

Downgrades are not supported. A user who installs an older CLI against a state bucket written by a newer one will be blocked by the schema check. Deployments are not downgradable in-place; a destroy-and-recreate cycle is required. This is an acceptable constraint given that the upgrade path is straightforward and downgrades in production infrastructure are generally a signal that something else went wrong.

---

## v0.0.1 Roadmap Scope

The v0.0.1 MVP includes:

- All commands in [commands.md](./commands.md) implemented and working end-to-end.
- Real EC2 deployment lifecycle (deploy, status, destroy).
- SSM tunnel and shell.
- State bucket bootstrap, discovery, and persistence.
- Plugin upload and enable/disable persistence (but no runtime plugin loading yet; the runtime is still the v0.0.1 container).
- IAM policy generator.
- Prerequisite checks.
- Human and `--json` output modes.
- Full error class hierarchy with remediation hints.
- Unit and integration test coverage.
- E2E test for the full deploy/tunnel/destroy lifecycle.
