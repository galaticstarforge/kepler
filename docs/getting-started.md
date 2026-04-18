# Getting Started with Kepler

This guide walks you through your first Kepler deployment.

## Prerequisites

- **Node.js 20+** — [Download](https://nodejs.org/)
- **AWS Account** with appropriate permissions
- **AWS CLI v2** — [Install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **Session Manager plugin** — Required for `kepler tunnel` and `kepler ssh`

### Session Manager Plugin Installation

**macOS:**
```bash
brew install --cask session-manager-plugin
```

**Linux (Debian/Ubuntu):**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o session-manager-plugin.deb
sudo dpkg -i session-manager-plugin.deb
```

**Windows:**
Download and run the installer from [AWS docs](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).

## AWS Credentials Setup

Kepler uses the standard AWS credential chain. Configure one of:

### Environment variables
```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
```

### AWS CLI profiles
```bash
aws configure --profile kepler
export AWS_PROFILE=kepler
```

### AWS SSO
```bash
aws sso login --profile my-sso-profile
export AWS_PROFILE=my-sso-profile
```

## IAM Permissions

Generate the recommended IAM policy:
```bash
kepler iam-policy
```

Or create it directly in your account:
```bash
kepler iam-policy --create
```

## Quick Start

### 1. Install the CLI
```bash
npm install -g @keplerforge/cli
```

### 2. Initialize
```bash
kepler init
```
This creates a state bucket in S3 for tracking deployments and writes local config to `~/.config/kepler/state.yaml`.

### 3. Deploy
```bash
kepler deploy my-deployment
```
You'll be prompted to select:
- **Instance tier:** small (~$70/mo), medium (~$120/mo), or large (~$280/mo)
- **VPC strategy:** create new or use default

Deployment takes ~10 minutes.

### 4. Connect
```bash
kepler tunnel
```
This opens an SSM port-forwarding tunnel to your deployment.

### 5. Verify
```bash
curl http://localhost:8080/health
# {"status":"ok","version":"0.0.1","uptime":42}
```

## Multi-user Setup

A second user on a different machine can connect to an existing deployment:

```bash
npm install -g @keplerforge/cli
kepler discover    # finds the existing state bucket
kepler tunnel      # connects to the deployment
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `kepler init` | Initialize state bucket |
| `kepler deploy <name>` | Deploy or update a stack |
| `kepler status [name]` | Show deployment status |
| `kepler tunnel [name]` | Open SSM tunnel |
| `kepler ssh [name]` | Open SSM shell |
| `kepler destroy <name>` | Tear down deployment |
| `kepler discover` | Find existing deployments |
| `kepler config get/set` | Read/write config |
| `kepler plugin ...` | Manage plugins |
| `kepler iam-policy` | Print/create IAM policy |
| `kepler info` | Show version and environment |

All commands support `--json` for machine-readable output.

## Troubleshooting

### "AWS credentials not configured"
Ensure you have valid credentials via `aws sts get-caller-identity`.

### "Session Manager plugin is not installed"
Install the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).

### "SSM agent not yet ready"
Wait 1-2 minutes after deployment for the instance to initialize and the SSM agent to register.

### "Deployment is in failed state"
Run `kepler destroy <name>` and then `kepler deploy <name>` to recreate.

### Tunnel connects but curl fails
The Docker container may still be pulling. SSH in and check:
```bash
kepler ssh my-deployment
sudo docker compose -f /opt/kepler/docker-compose.yml logs
```
