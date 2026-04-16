# Deployment Model

This document covers what the CLI deploys, the options available at deploy time, how changes to an existing deployment are handled, and how the runtime image gets onto the instance.

---

## Instance Tiers

Three named tiers are surfaced as choices during interactive deploys. The tier determines the instance type and EBS volume size.

| Tier | Instance | vCPU | RAM | EBS | Approx $/month | Intended Use |
|---|---|---|---|---|---|---|
| Small | `t3.large` | 2 | 8 GB | 100 GB | $60 | Personal use, up to ~30 repos |
| Medium | `m7i.large` | 2 | 8 GB | 200 GB | $120 | Small teams, up to ~100 repos |
| Large | `m7i.2xlarge` | 8 | 32 GB | 400 GB | $280 | Organizations with large codebases |

Cost estimates cover compute and EBS storage only. Usage-based costs (Bedrock KB queries, S3 operations, data transfer, NAT gateway data processing) are typically an additional $10-40 per month depending on workload.

These are disclosed separately at deploy time.

Power users can override the instance type entirely via `--instance-type <type>` on `deploy`. The named tiers remain the default UX.

Tier changes post-deployment work: run `kepler deploy` with `--instance-tier <new>` against the same deployment name. CloudFormation triggers a stop/start cycle on the EC2 instance, which takes roughly 3-8 minutes of downtime. The CLI warns before proceeding.

---

## VPC Strategy

At deploy time, the CLI prompts for one of three VPC strategies:

**Create new** (recommended default). Provisions a dedicated VPC with one public subnet, one private subnet, one NAT gateway, and appropriate route tables. Isolates the Kepler deployment from existing infrastructure. Adds approximately $32/month for the NAT gateway.

**Use default VPC.** Deploys into the account's default VPC if one exists. Cheapest option. Suitable for low-stakes evaluations. Some AWS accounts, especially enterprise-managed ones, have default VPCs disabled.

**Use existing VPC.** The CLI enumerates VPCs in the region, presents them with tags and CIDR ranges, and prompts for selection. The user also selects which subnet the instance will be placed in (must be a private subnet or have NAT-backed outbound for SSM to function). For existing-VPC deploys, the CLI validates that the subnet has outbound connectivity. If not, it warns and offers to create the required VPC endpoints as part of the stack.

The VPC choice is recorded in the deployment config and is not changeable without a full redeploy. Moving a deployment between VPCs requires destroy and recreate.

---

## What Gets Provisioned

A complete deployment is a single CloudFormation stack named `kepler-<deployment-name>`. Everything below is managed by that stack.

**VPC layer** (when creating new):
- VPC (`10.42.0.0/16` by default; overridable via `--vpc-cidr`)
- Public subnet (`10.42.1.0/24`) with Internet Gateway route
- Private subnet (`10.42.2.0/24`) with NAT Gateway route
- Internet Gateway, NAT Gateway, Elastic IP, route tables and associations

**Compute layer:**
- EC2 instance in the private subnet, no public IP
- EBS gp3 root volume, encrypted with the AWS-managed key
- EC2 Launch Template with the user-data bootstrap script
- Instance Profile with the deployment's IAM role

**IAM layer:**
- IAM Role for the EC2 instance (SSM access, S3 read/write on docs bucket, S3 read on state bucket, CloudWatch Logs write, Bedrock invoke)
- Optional: IAM Managed Policy for users (`KeplerUserAccess`): only created if the user runs `kepler iam-policy --create` explicitly

**Storage layer:**
- S3 docs bucket named `kepler-docs-<deployment>-<account-id>-<region>`. Versioning, encryption, public access block, and lifecycle rules applied.
- The state bucket is shared across deployments and is not part of the per-deployment stack. It's created once by `kepler init`.

**Observability layer:**
- CloudWatch Log Group `/kepler/<deployment-name>` with 30-day retention

**Networking layer:**
- Security Group for the EC2 instance. No inbound rules. Outbound: all allowed. SSM traffic flows over outbound HTTPS to AWS service endpoints.

**Semantic index layer** (when enabled):
- Bedrock Knowledge Base pointing at the docs bucket, including chunking strategy, embedding model selection, and IAM role for KB access.

All resources are tagged with `kepler:deployment=<name>`, `kepler:managed=true`, and `kepler:version=<cli-version>`.

---

## CloudFormation as State

CloudFormation is the authoritative state store for per-deployment infrastructure. The CLI never maintains its own state file for AWS resources. Stack operations map directly to CLI commands:

- **Create:** `kepler deploy <name>` against a non-existent stack.
- **Update:** `kepler deploy <name>` against an existing stack.
- **Read:** `kepler status <name>` queries `CloudFormation:DescribeStacks`.
- **Delete:** `kepler destroy <name>` calls `CloudFormation:DeleteStack`.

Stack outputs are the contract between CloudFormation and the CLI:

| Output | Value |
|---|---|
| `InstanceId` | EC2 instance ID for SSM targeting |
| `VpcId` | VPC hosting the deployment |
| `DocsBucketName` | S3 bucket for documents |
| `LogGroupName` | CloudWatch log group |
| `Region` | Deployment region |
| `DeploymentName` | Deployment name |
| `CoreVersion` | Runtime version deployed |

The CLI reads these outputs to discover the deployment's runtime addresses. No other mechanism is used. No Parameter Store, no tag-based lookup as primary source.

Failed deploys leave the stack in a `ROLLBACK_COMPLETE` or similar failed state. The CLI does not auto-retry or auto-clean. The user is prompted on next `deploy` to either delete-and-recreate or investigate.

---

## CDK Bootstrap

CDK requires one-time bootstrapping per account/region before the first deployment. The bootstrap process creates a dedicated CloudFormation stack (`CDKToolkit`) that provisions an S3 bucket for assets, an ECR repository, and IAM roles used by CDK during deployment.

The CLI detects missing bootstrap and runs it transparently:

```
$ kepler deploy my-deployment
✓ AWS credentials validated
⚠ CDK not yet bootstrapped in us-east-1. Bootstrapping now...
  (This is a one-time setup step for first-ever deployments in this region.)
✓ CDK bootstrap complete
✓ Proceeding with deployment...
```

Detection is done by attempting `CloudFormation:DescribeStacks` for `CDKToolkit`. Bootstrap uses the CDK API programmatically, not a shell-out. The user never needs to know CDK exists.

---

## Runtime Container Image

`@kepler/core` publishes a Docker container image to GitHub Container Registry at `ghcr.io/<org>/kepler-core:<version>`. The EC2 user-data script pulls this image during instance boot and runs it via Docker Compose.

The image tag is determined by the CLI's own version. Installing `@kepler/cli@0.3.2` means deployments embed `ghcr.io/<org>/kepler-core:0.3.2`. This pinning guarantees reproducibility. Re-deploying the same CLI version always produces the same runtime image.

The image is public. Anyone can pull it; authentication is not required. The image does nothing useful without a Kepler deployment's configuration, so public availability does not leak information.
