# Commands

All commands support the [global flags](#global-flags) listed at the bottom of this document. Commands are listed here in the order a typical first-time user would encounter them.

---

## `kepler init`

Bootstrap the local CLI setup. Either discovers an existing state bucket or creates a new one.

**Behavior:**

1. Verify AWS credentials via `STS:GetCallerIdentity`.
2. If local state file exists with a valid bucket pointer, print status and exit 0. (Idempotent.)
3. Run state bucket discovery (see [state model](./state.md)).
4. If the user chooses to create: generate name `kepler-state-<6-char-random>`, create the bucket with required configuration, write `_meta/state-bucket-version.yaml`.
5. Write local state file.
6. Print next-step guidance.

**Flags:**

- `--bucket <name>`: skip discovery and use the named bucket. Validates that it's either empty (to initialize) or an existing Kepler state bucket.
- `--region <region>`: override the default region.

---

## `kepler discover`

Find an existing Kepler state bucket in the account and populate local state. Intended for second-user onboarding.

**Behavior:**

1. Verify AWS credentials.
2. Skip the local-state-exists check (explicit re-discovery is allowed).
3. Run state bucket discovery.
4. On selection, list all deployments in the bucket with their CloudFormation statuses.
5. Write local state file.

Unlike `init`, `discover` never creates a bucket.

**Flags:** `--region <region>`

---

## `kepler deploy <deployment-name>`

Create or update a Kepler deployment. Typical duration: 8-15 minutes for a fresh deploy, 2-10 minutes for updates depending on what changed.

**Behavior:**

1. Verify AWS credentials and prerequisites (including Session Manager plugin).
2. Read local state; fail if not initialized.
3. Check for existing CloudFormation stack `kepler-<deployment-name>`:
   - `CREATE_COMPLETE` or `UPDATE_COMPLETE`: prompt for update confirmation.
   - Transitional state (e.g., `UPDATE_IN_PROGRESS`): fail with a clear message.
   - `ROLLBACK_COMPLETE` or failed: prompt to delete and recreate.
   - Not found: proceed with creation.
4. Interactive prompts (skipped when corresponding flags are provided):
   - Instance tier
   - VPC strategy
   - Whether to enable Bedrock Knowledge Base
5. Display a change preview with cost estimate.
6. Confirm.
7. Run CDK synth and deploy programmatically. Stream progress to the user with a spinner and step-by-step event summaries.
8. On success: persist deployment config to state bucket, update `lastUsedDeployment` in local state, print summary.

**Flags:**

- `--instance-tier <small|medium|large>`
- `--instance-type <type>`: overrides tier-derived type.
- `--vpc-strategy <create|default|existing>`
- `--existing-vpc-id <id>`: required when `--vpc-strategy existing`.
- `--existing-subnet-id <id>`: required when `--vpc-strategy existing`.
- `--enable-bedrock-kb` / `--no-enable-bedrock-kb`
- `--yes`: skip confirmation prompts.
- `--dry-run`: synthesize the stack and print the change set without applying.

---

## `kepler status [deployment-name]`

Show the current state of a deployment.

**Behavior:** queries CloudFormation for stack status and outputs, EC2 for instance state (type, private IP), and SSM for instance agent status. Displays all of the above plus last-deploy timestamp and deployed runtime version.

**Flags:**

- `--all`: list all deployments in the state bucket with their statuses.

**JSON mode:** returns a structured object with every field.

```bash
$ kepler status my-deployment --json
{
  "deploymentName": "my-deployment",
  "region": "us-east-1",
  "stackStatus": "CREATE_COMPLETE",
  "instanceId": "i-0a1b2c3d4e5f",
  "instanceType": "m7i.large",
  "instanceState": "running",
  "docsBucket": "kepler-docs-my-deployment-123456789012-us-east-1",
  "coreVersion": "0.3.2",
  "deployedAt": "2026-04-16T14:23:11Z",
  "ssmAgentStatus": "Online"
}
```

---

## `kepler destroy <deployment-name>`

Permanently remove a deployment and its associated AWS resources.

**Behavior:**

1. Require explicit confirmation: the prompt asks the user to type the deployment name.
2. Empty the docs bucket (or skip with `--keep-docs-bucket`). S3 buckets with content cannot be deleted by CloudFormation unless empty.
3. Call CloudFormation delete-stack.
4. Poll until deletion completes.
5. Move the deployment's config from `deployments/<name>/` to `archive/deployments/<name>-<timestamp>/` in the state bucket (soft delete).
6. If the destroyed deployment was `lastUsedDeployment`, clear that field in local state.

**Flags:**

- `--keep-docs-bucket`: detach the docs bucket from the stack before destroying. The bucket survives with its contents intact.
- `--yes`: skip the type-to-confirm prompt. Discouraged.

---

## `kepler tunnel [deployment-name]`

Open an SSM port-forwarding tunnel to the deployment. See [connectivity](./connectivity.md) for full details.

**Flags:**

- `--local-port <n>` (default 8080)
- `--remote-port <n>` (default 8080)
- `--detach`
- `--cleanup`: terminate dangling SSM sessions and exit.

---

## `kepler ssh [deployment-name]`

Open an interactive SSM shell on the deployment's EC2 instance. See [connectivity](./connectivity.md) for full details.

---

## `kepler plugin` subcommands

### `kepler plugin upload <path>`

Package and upload a plugin.

**Behavior:** validates that `<path>` points to a Node package with a valid `package.json`, runs `npm pack` to produce a tarball, uploads it to the state bucket under `deployments/<name>/plugins/packages/`, and validates that the plugin declares a Kepler plugin manifest via `@kepler/plugin-sdk`. Rejects if the manifest is missing. Uploading does not enable the plugin. That's a separate step.

### `kepler plugin enable <name>`

Add a plugin to the deployment's enabled list.

**Behavior:** verifies the plugin has been uploaded, reads `plugins/enabled.yaml`, adds the plugin if not already present, writes back, then triggers a runtime reload over a temporary SSM tunnel. In v0.0.1, the runtime has no plugin loading mechanism yet. The command persists the enabled state and prints a notice that runtime effect is pending.

### `kepler plugin disable <name>`

Remove a plugin from the enabled list. Counterpart to `enable`.

### `kepler plugin list`

List plugins in the deployment's state bucket. Shows uploaded plugins with versions and enabled/disabled status.

### `kepler plugin logs <name>`

Tail logs for a specific plugin from CloudWatch. Filters by the plugin's log context prefix within the deployment's log group.

**Flags:**

- `--follow, -f`: stream new log entries as they arrive.
- `--since <duration>`: e.g., `1h`, `24h`.
- `--grep <pattern>`: filter by regex.

---

## `kepler iam-policy`

Generate or create the recommended IAM user-access policy.

**Behavior:**
- Without `--create`: print the policy document to stdout as JSON. Useful for piping into `aws iam create-policy`, for review, or for copy-pasting into Terraform/CDK.
- With `--create`: prompt for a policy name (default `KeplerUserAccess`), create the managed policy in the current account, print the ARN and example attachment commands.

**Flags:**

- `--create`
- `--name <name>`: policy name when creating.
- `--deployment <name>`: generate a deployment-scoped policy (resources restricted to a specific deployment) instead of the account-wide default.

---

## `kepler config get <key>` / `kepler config set <key> <value>`

Read or modify the deployment's persisted configuration in the state bucket.

**Settable keys in v0.0.1:**

- `instanceTier`: takes effect on next `kepler deploy`.
- `enabledPlugins`: list manipulation is better done via `plugin enable/disable`.

Many config keys are read-only because they require a stack redeploy to change (VPC, region, etc.). Attempting to set those prints a clear error explaining the path (destroy and recreate).

---

## `kepler version`

Print version information.

```
Kepler CLI v0.3.2
  Node:         v20.11.1
  Region:       us-east-1
  State bucket: kepler-state-7a3f9b
  AWS account:  123456789012 (arn:aws:iam::123456789012:user/alice)
```

`--json` returns a structured object with every field. It prints everything an operator needs to triage a problem.

---

## `kepler upgrade`

Check for a newer CLI version on npm and report whether the CLI version matches the deployed runtime version.

**Behavior:** checks npm for the latest `@kepler/cli` version, compares to the installed version, and compares the installed CLI version to the deployed runtime version from CloudFormation outputs. Prints status and instructions.

This command does not upgrade anything itself. It runs diagnostic checks and prints `npm install -g @kepler/cli@latest` as the upgrade instruction. For runtime upgrades, the user runs `kepler deploy <name>` with the new CLI, which pulls the matching runtime image.

---

## Global Flags

Available on every command:

| Flag | Description |
|---|---|
| `--json` | Machine-readable output. Errors become JSON objects; prompts become errors if required values are missing. |
| `--region <region>` | Override AWS region for this invocation. |
| `--profile <profile>` | Override AWS credential profile. |
| `--verbose, -v` | Enable debug logging, including AWS SDK request IDs and timing data. |
| `--quiet, -q` | Suppress non-error output. |
| `--no-color` | Disable colored output. |
| `--help, -h` | Print command help. |
| `--version, -V` | Print CLI version. |

Environment variable equivalents: `KEPLER_REGION`, `AWS_PROFILE`, `KEPLER_LOG_LEVEL`, `NO_COLOR`, `KEPLER_STATE_FILE`.

---

## Error Handling

### Error Classes

Every CLI error has a stable code (`KPL_E_XXXX`), a human-readable message, a remediation hint, and a defined exit code.

| Class | Code | Exit | When |
|---|---|---|---|
| `AwsCredentialsError` | KPL_E_0001 | 1 | No credentials, expired, or invalid |
| `AwsPermissionDeniedError` | KPL_E_0002 | 1 | AWS API returned AccessDenied |
| `StateBucketNotFoundError` | KPL_E_0003 | 1 | Local state references a nonexistent bucket |
| `StateBucketInvalidError` | KPL_E_0004 | 1 | Bucket exists but is not a Kepler state bucket |
| `DeploymentNotFoundError` | KPL_E_0005 | 1 | No CloudFormation stack for the requested deployment |
| `DeploymentStateError` | KPL_E_0006 | 1 | Stack is in a transitional or failed state |
| `SsmPluginNotInstalledError` | KPL_E_0010 | 1 | Session Manager plugin is not available |
| `SsmAgentUnreachableError` | KPL_E_0011 | 1 | Instance is running but SSM agent is not registered |
| `PluginValidationError` | KPL_E_0020 | 1 | Uploaded plugin is malformed or missing manifest |
| `PluginAlreadyEnabledError` | KPL_E_0021 | 0 | `plugin enable` on an already-enabled plugin (idempotent) |
| `ConfigKeyReadOnlyError` | KPL_E_0030 | 1 | Attempt to `config set` a read-only key |
| `UserCancelledError` | KPL_E_0040 | 130 | User pressed Ctrl-C |
| `PrerequisiteError` | KPL_E_0050 | 1 | A required tool or condition is missing |
| `InternalError` | KPL_E_9999 | 2 | Unexpected failure; bug report requested |

### Exit Codes

- `0`: success, or idempotent no-op.
- `1`: user-correctable failure (wrong input, missing prerequisite, permission issue).
- `2`: internal error (CLI bug).
- `130`: user cancelled via Ctrl-C.

Exit codes are stable. Automation may branch on them reliably.

### Remediation Hints

Every error includes a remediation hint. Example:

```
Error: Session Manager plugin not installed (KPL_E_0010)

  The 'kepler tunnel' command requires the AWS Session Manager plugin.

  To fix (macOS):
    brew install --cask session-manager-plugin

  To fix (Linux):
    curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
    sudo dpkg -i session-manager-plugin.deb

  For more: https://docs.kepler.dev/errors/KPL_E_0010
```

The hints are generated by the error classes themselves, not by the command handlers, so they stay consistent across all invocations.
