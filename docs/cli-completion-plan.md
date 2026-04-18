# Kepler CLI – Completion Plan

> Generated 2026-04-16. Build ✅ | Lint ✅ | Typecheck ✅ | Tests ✅

## Current State Summary

The CLI MVP is structurally complete: all 11 commands are wired up, build tooling works, and the installer deploys real CDK infrastructure. The gaps below are what separate "scaffold that compiles" from "production-ready v0.0.1".

---

## 1. Critical Issues (Must Fix for v0.0.1)

### 1.1 `removeComments` in installer tsup config
**File:** `packages/installer/tsup.config.ts` line 9  
**Problem:** `removeComments: true` is not a valid tsup option. Build succeeds today because tsup ignores unknown keys, but it's misleading and may break on a tsup upgrade.  
**Fix:** Remove the line.

### 1.2 Dead code: CDK construct files & `app.ts`
**Files:**
- `packages/installer/src/app.ts`
- `packages/installer/src/stacks/kepler-stack.ts`
- `packages/installer/src/stacks/constructs/kepler-vpc.ts`
- `packages/installer/src/stacks/constructs/kepler-storage.ts`
- `packages/installer/src/stacks/constructs/kepler-instance.ts`
- `packages/installer/src/stacks/constructs/kepler-iam.ts`

**Problem:** None of these are imported or used. The deployer generates an inline CDK app as a JavaScript string (`deployer.ts:prepareCdkApp`). These files are dead code that will confuse contributors.  
**Decision needed:** Either delete them, or refactor the deployer to use them (see §3.1).

### 1.3 Dead code: `not-implemented.ts`
**File:** `packages/cli/src/not-implemented.ts`  
**Problem:** No longer imported anywhere. Should be deleted.

### 1.4 Plugin `logs` subcommand is stubbed
**File:** `packages/cli/src/commands/plugin.ts` lines 233-237  
**Problem:** Just prints "Plugin logs not implemented in v0.0.1." and exits. The CLI advertises it via `kepler plugin logs <name>`.  
**Options:**
- **A)** Implement using CloudWatch Logs (the log group `/kepler/<deployment>` already exists). Pull logs via `FilterLogEventsCommand` filtering by plugin name prefix.
- **B)** Remove the subcommand entirely from v0.0.1 and document it as planned.
- **C)** Leave the stub but print a clearer message with the CloudWatch Logs console URL.

### 1.5 Hardcoded version `'0.0.1'` in deploy command
**File:** `packages/cli/src/commands/deploy.ts` line 86 (`keplerVersion: '0.0.1'`)  
**Problem:** Should read from `@keplerforge/shared` constants or `package.json` so version bumps propagate automatically.  
**Fix:** Import `KEPLER_VERSION` from `@keplerforge/shared/constants` (already exported).

---

## 2. Security & Correctness Issues

### 2.1 Overpermissioned IAM: Bedrock wildcard
**File:** `packages/installer/src/deployer.ts` line ~167 (inline CDK app)  
**Problem:** `resources: ['*']` for `bedrock:InvokeModel` grants access to invoke any Bedrock model in any region. Should be scoped to the deployment region at minimum.  
**Fix:** Use `arn:aws:bedrock:${config.region}:*:*` or allow users to configure allowed model IDs.

### 2.2 Overpermissioned IAM: ECR wildcard
**File:** `packages/installer/src/deployer.ts` line ~173 (inline CDK app)  
**Problem:** `resources: ['*']` for ECR pull. The `GetAuthorizationToken` action legitimately requires `*`, but `GetDownloadUrlForLayer` and `BatchGetImage` should be scoped.  
**Fix:** Split into two statements — one for `GetAuthorizationToken` on `*`, one for image pull scoped to the specific repository ARN.

### 2.3 IAM policy in `iam-policy.ts` has malformed ARNs
**File:** `packages/cli/src/commands/iam-policy.ts` lines 113-114  
**Problem:** ARNs use `arn:aws:iam::*:role/kepler-*` (double colon, missing account). Should be `arn:aws:iam::*:role/kepler-*` — actually the format `arn:aws:iam:::role/...` drops the account partition. Verify the correct format is `arn:aws:iam::*:role/kepler-*` (single empty region, wildcard account).  
**Fix:** Audit all ARNs in the policy document against AWS IAM documentation.

### 2.4 SSM plugin detection is fragile on Windows
**File:** `packages/cli/src/lib/prerequisites.ts` lines 40-52  
**Problem:** Uses Unix exit code 127 to detect "command not found". On Windows, `execSync` throws a different error structure. Current fallback logic is three layers deep and may give false positives.  
**Fix:** On Windows, check `where.exe session-manager-plugin` instead.

### 2.5 State bucket has no encryption at rest configured
**File:** `packages/cli/src/lib/state-bucket.ts` — `createStateBucket()`  
**Problem:** The `PutBucketEncryptionCommand` enables SSE-S3 (AES256), which is fine. However, verify this is actually called — confirm the function completes the full setup.  
**Fix:** Verify the function includes the encryption call (it does based on earlier review).

---

## 3. Architecture Improvements (Recommended for v0.0.1)

### 3.1 Refactor deployer to use CDK constructs
**Files:** `packages/installer/src/deployer.ts` vs `packages/installer/src/stacks/`  
**Problem:** The deployer generates a ~150-line inline JavaScript string as the CDK app (`prepareCdkApp`). This is:
- Not type-checked at compile time
- Not testable in isolation
- Hard to maintain — one misplaced backtick breaks the deployment
- Duplicates what the construct files already define

**Approach:** Refactor `prepareCdkApp` to write a thin `app.mjs` that imports from the built installer package (already in `dist/`), or use CDK's programmatic API to synth the template directly from TypeScript and pass it to `cdk deploy --app 'cat template.json'`.

### 3.2 Type duplication between shared and installer
**Files:** `packages/shared/src/types.ts` vs `packages/installer/src/types.ts`  
**Problem:** Both define `DeploymentConfig` and `DeploymentOutputs` with slightly different fields. The CLI imports from `@keplerforge/installer` while the shared types go unused.  
**Fix:** Have `@keplerforge/installer` re-export types from `@keplerforge/shared`, or consolidate so there's one source of truth.

---

## 4. Missing Features (v0.0.1 Scope)

### 4.1 `kepler deploy` update flow
**File:** `packages/cli/src/commands/deploy.ts` lines 60-63  
**Problem:** When a deployment already exists in `CREATE_COMPLETE`/`UPDATE_COMPLETE` state, the user is prompted "Update?" but the same `deploy()` function is called with a new config. The CDK will attempt an `UpdateStack`, which should work, but:
- The old config in S3 is overwritten, not versioned
- No diff is shown to the user before updating
- No rollback instructions are provided

**Improvement:** Show a config diff before updating. Use `cdk diff` to preview infrastructure changes.

### 4.2 `kepler config set` is limited
**File:** `packages/cli/src/commands/config.ts`  
**Problem:** Only `instanceTier` is writable. Users can't change VPC strategy, region, or version after initial deploy.  
**Fix:** Expand the writable keys list. For keys that require redeployment, warn the user.

### 4.3 Plugin enable/disable has no effect
**File:** `packages/cli/src/commands/plugin.ts`  
**Problem:** Enabling/disabling a plugin writes to S3 (`enabled.yaml`) but the running instance doesn't pick up the change. The user is told "Restart effect not implemented in v0.0.1."  
**Minimum fix for v0.0.1:** After updating `enabled.yaml`, send an SSM command to restart the kepler service on the instance: `sudo systemctl restart kepler.service`.

### 4.4 No `kepler logs` command
**Problem:** No way to view deployment logs from the CLI. The CloudWatch log group exists (`/kepler/<deployment>`) but there's no command to tail it.  
**This is different from `plugin logs`** — this would show core runtime logs.  
**Suggestion:** Add as a v0.1.0 feature, or implement a basic `kepler logs` that wraps `aws logs tail`.

---

## 5. Test Coverage Gaps

### 5.1 No unit tests
**Problem:** Zero unit tests. Only an E2E test that requires AWS credentials.  
**Priority files for unit tests:**
1. `packages/cli/src/lib/state-bucket.ts` — mock S3 calls, verify key paths and YAML serialization
2. `packages/cli/src/lib/config.ts` — mock filesystem, verify state.yaml read/write
3. `packages/cli/src/lib/prerequisites.ts` — mock execSync, verify detection logic
4. `packages/installer/src/deployer.ts` — mock CDK/execa, verify app generation and output parsing

### 5.2 E2E test gaps
**File:** `packages/cli/test/e2e.test.ts`  
**Missing flows:** discover, ssh, plugin upload/enable/disable/list, config get/set, iam-policy print.

---

## 6. Polish & Developer Experience

| Item | File(s) | Effort |
|------|---------|--------|
| Add `--version` flag to root CLI | `packages/cli/src/index.ts` | Small |
| Add `--region` global override | `packages/cli/src/index.ts` | Small |
| Colorized deployment status | `packages/cli/src/commands/status.ts` | Small |
| Spinner consistency (some commands use ora, some don't) | Various | Small |
| Validate deployment name format (alphanumeric + dash only) | `deploy.ts`, `init.ts` | Small |
| Add `--yes` flag to skip all prompts | Global option | Medium |
| Add `kepler whoami` alias for `kepler info` | `index.ts` | Trivial |

---

## 7. Recommended Execution Order

```
Phase 1 — Cleanup & correctness (1 session)
  ├─ Delete dead code (not-implemented.ts, consider stacks/)
  ├─ Fix removeComments in installer tsup.config.ts
  ├─ Fix hardcoded version in deploy.ts
  ├─ Fix IAM wildcard permissions in deployer.ts
  ├─ Fix SSM plugin detection for Windows
  └─ Fix IAM policy ARN format in iam-policy.ts

Phase 2 — Type consolidation (1 session)
  ├─ Unify DeploymentConfig/DeploymentOutputs types
  └─ Have installer import from shared

Phase 3 — Feature completion (1-2 sessions)
  ├─ Implement plugin logs (CloudWatch Logs)
  ├─ Implement plugin enable/disable with SSM restart
  ├─ Add --version flag and --region global override
  ├─ Add --yes flag for non-interactive mode
  └─ Validate deployment name format

Phase 4 — Refactor deployer (1-2 sessions)
  ├─ Replace inline CDK string with proper construct imports
  ├─ Add cdk diff preview before updates
  └─ Add unit tests for deployer

Phase 5 — Test coverage (1-2 sessions)
  ├─ Unit tests for lib modules
  ├─ Unit tests for commands (mocked)
  └─ Expand E2E test matrix
```

---

## Appendix: File Status Matrix

| File | Status | Notes |
|------|--------|-------|
| `cli/src/index.ts` | ✅ Complete | |
| `cli/src/commands/init.ts` | ✅ Complete | |
| `cli/src/commands/deploy.ts` | ⚠️ Functional | Hardcoded version, no update diff |
| `cli/src/commands/destroy.ts` | ✅ Complete | |
| `cli/src/commands/status.ts` | ✅ Complete | |
| `cli/src/commands/discover.ts` | ✅ Complete | |
| `cli/src/commands/tunnel.ts` | ✅ Complete | |
| `cli/src/commands/ssh.ts` | ✅ Complete | |
| `cli/src/commands/plugin.ts` | ⚠️ Partial | `logs` stubbed, enable/disable no-op |
| `cli/src/commands/iam-policy.ts` | ✅ Complete | ARNs need audit |
| `cli/src/commands/config.ts` | ⚠️ Limited | Only 1 writable key |
| `cli/src/commands/version.ts` | ✅ Complete | |
| `cli/src/lib/aws-clients.ts` | ✅ Complete | |
| `cli/src/lib/config.ts` | ✅ Complete | |
| `cli/src/lib/errors.ts` | ✅ Complete | |
| `cli/src/lib/logger.ts` | ✅ Complete | |
| `cli/src/lib/prerequisites.ts` | ⚠️ Fragile | Windows SSM detection |
| `cli/src/lib/prompts.ts` | ✅ Complete | |
| `cli/src/lib/state-bucket.ts` | ✅ Complete | |
| `cli/src/not-implemented.ts` | 🗑️ Dead code | Delete |
| `installer/src/deployer.ts` | ⚠️ Functional | Inline CDK, IAM wildcards |
| `installer/src/types.ts` | ⚠️ Duplicated | Types also in shared |
| `installer/src/app.ts` | 🗑️ Dead code | Not imported |
| `installer/src/stacks/**` | 🗑️ Dead code | Not imported |
| `core/src/index.ts` | ✅ Complete (for v0.0.1) | Health/ready/metrics only |
| `shared/src/**` | ✅ Complete | |
| `plugin-sdk/src/index.ts` | ✅ Complete (interface only) | No runtime — expected for v0.0.1 |
