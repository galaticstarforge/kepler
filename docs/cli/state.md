# State Model

Kepler state is split between a local pointer file and a remote S3 bucket. The split exists because local state is single-user and lost with the machine, while remote state is multi-user and survives machine changes. The only thing that must be local is the pointer. Everything else is reconstructable from S3. I think this split is the simplest model that gives you sharable, durable state without any coordination overhead.

---

## Local State

Path: `~/.config/kepler/state.yaml` (or platform equivalent).

```yaml
stateBucket: kepler-state-7a3f9b      # Required after `kepler init`.
region: us-east-1                      # Region the state bucket lives in.
lastUsedDeployment: my-deployment      # Optional. Most-recently-used deployment name.
cliVersion: 0.3.2                      # Version of CLI that last wrote this file.
```

The file is created by `kepler init` and `kepler discover`. The CLI writes it atomically: write to a temp file, then rename. It's human-readable and safe to edit manually, though that's rarely necessary.

The file contains no secrets. It's not encrypted. It's safe to sync across machines via a dotfiles repo, though most users run `kepler discover` on each new machine rather than copying state files around.

---

## Remote State (S3)

The state bucket is an S3 bucket in the user's account that holds all other CLI state. A single state bucket may hold multiple deployments.

**Bucket naming:** `kepler-state-<6-char-random-suffix>`. The random suffix prevents S3 namespace collisions (S3 bucket names are globally unique) and makes auto-discovery unambiguous. The prefix `kepler-state-` is the discovery signal, and the suffix disambiguates accounts that end up with more than one.

**Bucket configuration (enforced at creation):**

- Versioning enabled.
- Encryption: SSE-S3 by default. KMS optional via a future flag.
- Public access block: all four settings enabled.
- Lifecycle: noncurrent versions retained for 30 days, then expired.
- Bucket policy: denies all requests from outside the owning account.
- Tags: `kepler:managed=true`, `kepler:purpose=state`.

**Bucket layout:**

```
kepler-state-7a3f9b/
├── _meta/
│   └── state-bucket-version.yaml       # Schema version for future migrations.
│
├── deployments/
│   └── {deployment-name}/
│       ├── config.yaml                 # Deployment config.
│       ├── cdk-outputs.json            # CloudFormation stack outputs.
│       ├── plugins/
│       │   ├── enabled.yaml            # List of enabled plugins.
│       │   └── packages/
│       │       └── <plugin>-<version>.tgz
│       └── history/
│           └── {timestamp}-{action}.yaml   # CLI operation audit log.
│
└── archive/
    └── deployments/
        └── {deployment-name}-{timestamp}/   # Soft-deleted deployment records.
```

No secrets are stored in the state bucket. Plugin packages are npm-style tarballs that may contain build artifacts but are expected to be non-secret.

---

## Discovery and Auto-Onboarding

When a user runs the CLI for the first time on a new machine, or runs `kepler discover` explicitly, the CLI tries to locate an existing state bucket before creating a new one.

**Discovery algorithm:**

1. If local state file exists and points at a valid bucket, use that. Skip discovery.
2. List all buckets in the current AWS account via `S3:ListBuckets`.
3. Filter by name pattern `^kepler-state-[a-z0-9]{6}$`.
4. For each match, read `_meta/state-bucket-version.yaml` to verify it's a real Kepler state bucket. Reject ones that fail this check.
5. If exactly one match: prompt "Found existing state bucket `kepler-state-7a3f9b`. Use it? (Y/n)".
6. If multiple matches: present a list selector. Each entry shows the bucket name, number of deployments it contains, and the region.
7. If zero matches: fall through to `init` flow.

This is what makes second-user onboarding nearly instant. A new team member who has been granted IAM access to an existing deployment can get connected with two commands:

```bash
$ npm install -g @keplerforge/cli
$ kepler discover
✓ Found state bucket: kepler-state-7a3f9b
✓ Discovered 1 deployment: my-team-knowledge
✓ Local state written.

$ kepler tunnel
```

No credential sharing, no key distribution, no invite workflow. IAM is the gate. That's the whole model.
