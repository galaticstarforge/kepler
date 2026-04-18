# Internal Architecture

This document covers the package layout, how commands are dispatched, how AWS clients are managed, how CDK gets invoked without being globally installed, and the testing strategy.

---

## Package Layout

```
packages/cli/
├── bin/
│   └── kepler.js                  # Node shebang entry; imports from dist.
├── src/
│   ├── index.ts                   # Entry point; commander.js setup.
│   ├── commands/
│   │   ├── init.ts
│   │   ├── discover.ts
│   │   ├── deploy.ts
│   │   ├── status.ts
│   │   ├── destroy.ts
│   │   ├── tunnel.ts
│   │   ├── ssh.ts
│   │   ├── plugin/
│   │   │   ├── upload.ts
│   │   │   ├── enable.ts
│   │   │   ├── disable.ts
│   │   │   ├── list.ts
│   │   │   └── logs.ts
│   │   ├── iam-policy.ts
│   │   ├── config.ts
│   │   ├── version.ts
│   │   └── upgrade.ts
│   ├── lib/
│   │   ├── aws-clients.ts         # SDK v3 client singletons.
│   │   ├── state-bucket.ts        # S3 state operations.
│   │   ├── local-config.ts        # ~/.config/kepler/state.yaml ops.
│   │   ├── cfn.ts                 # CloudFormation helpers.
│   │   ├── ssm.ts                 # Session Manager helpers.
│   │   ├── cdk-deployer.ts        # Programmatic CDK invocation.
│   │   ├── logger.ts              # Structured logging, human + JSON.
│   │   ├── prompts.ts             # Inquirer wrappers.
│   │   ├── prerequisites.ts       # Pre-flight checks.
│   │   ├── errors.ts              # Error class hierarchy.
│   │   ├── iam-policy.ts          # Policy document generator.
│   │   └── constants.ts           # Region defaults, naming patterns, tags.
│   └── types/
│       └── index.ts               # Shared internal types.
├── test/
│   ├── unit/
│   └── e2e/
│       └── full-lifecycle.test.ts  # Real AWS tests (gated by KEPLER_E2E=1).
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## Command Dispatch

`src/index.ts` constructs the root `commander` program, registers every command, and invokes the parsed action. Each command file exports a single function conforming to:

```typescript
export interface CommandHandler<Args, Options> {
  (args: Args, options: Options, ctx: CommandContext): Promise<void>;
}

interface CommandContext {
  logger: Logger;
  config: LocalConfig;
  awsClients: AwsClientRegistry;
  jsonMode: boolean;
  cancelled: AbortSignal;
}
```

The dispatcher constructs `CommandContext` once per invocation, handles the Ctrl-C → AbortController plumbing, and wraps errors uniformly. Individual command handlers do not implement their own error wrapping. That's the dispatcher's job.

---

## AWS Client Management

`lib/aws-clients.ts` provides lazy singletons for each AWS service. Client construction respects:

- Region resolution order: flag > env > state file > default.
- Credential provider chain: SDK default (no custom logic).
- Retry strategy: adaptive, max 3 attempts.
- Timeout: 30 seconds per request.

Clients used:

- `@aws-sdk/client-s3`
- `@aws-sdk/client-cloudformation`
- `@aws-sdk/client-ec2`
- `@aws-sdk/client-ssm`
- `@aws-sdk/client-sts`
- `@aws-sdk/client-iam`
- `@aws-sdk/client-bedrock`
- `@aws-sdk/client-cloudwatch-logs`

---

## CDK Integration

CDK is consumed as a library, not invoked as a separate CLI process. The `@keplerforge/installer` package exports a deploy function that:

1. Constructs a `cdk.App` in-memory with the requested config.
2. Adds a single `KeplerStack` with the appropriate constructs.
3. Synthesizes the stack to a temporary directory.
4. Invokes the CDK CLI via `aws-cdk`'s Node API to deploy the synthesized template, streaming events back through a callback.

This approach avoids requiring users to have CDK installed globally, avoids subprocess complexity, and gives the CLI direct access to CDK's progress events for better UX during deploys.

---

## Prerequisites Checking

`lib/prerequisites.ts` implements pre-flight checks that are composed per command. Each command declares which checks it needs; they run before any action code executes.

**AWS credentials:** every command that talks to AWS calls `STS:GetCallerIdentity` first. This is fast and cached for the process lifetime.

**Session Manager plugin:** required by `tunnel` and `ssh`. Detection tries `session-manager-plugin --version` via PATH, then falls back to checking common installation paths per platform. Total failure emits `SsmPluginNotInstalledError` with platform-specific install instructions.

**Region availability:** when the user specifies a region, the CLI verifies it is valid and enabled in the account before running `deploy`. Opt-in regions that haven't been enabled in the account produce a clear error at the start of `deploy`, not deep in CDK execution where the error message is harder to parse.

**CDK bootstrap:** checked and auto-remediated at the start of `deploy`. Detection via `CloudFormation:DescribeStacks` for `CDKToolkit`.

**State bucket reachability:** commands that read/write the state bucket verify reachability with a `HeadBucket` call. A missing or inaccessible bucket produces `StateBucketNotFoundError` with a hint to run `kepler init` or check the local state file.

---

## Dependencies

Runtime dependencies are kept minimal:

- `commander`: command parsing.
- `@inquirer/prompts`: interactive prompts.
- `chalk`: colored output.
- `ora`: spinners.
- `boxen`: callout boxes.
- `yaml`: YAML parsing.
- `execa`: subprocess invocation (for SSM plugin shell-out).
- `aws-cdk-lib`, `aws-cdk`, `constructs`: CDK (via `@keplerforge/installer`).
- AWS SDK v3 modular clients (per above).

No large frameworks. No oclif, no AWS Amplify CLI, no Terraform. The CLI is purpose-built and the dependency list should stay that way.

Dev dependencies add TypeScript, vitest, tsup, eslint, and prettier.

---

## Testing Strategy

Three tiers:

**Unit tests.** Fast, no network. Cover state-bucket utility functions, config management, error formatting, prompt interactions (mocked), and CDK stack synthesis (verify the template structure matches expectations).

**Integration tests.** Moderate speed, use localstack or AWS SDK mocks. Cover command flows end-to-end without real AWS calls.

**E2E tests.** Slow, require real AWS. Gated by the `KEPLER_E2E=1` environment variable. Run the full lifecycle (`init` → `deploy` → `tunnel` → `destroy`) against a dedicated test AWS account. Typical cost per run: under $1. Not run in CI by default; run manually before tagging a release.

CI runs the unit and integration tiers. E2E is the pre-release gate.
