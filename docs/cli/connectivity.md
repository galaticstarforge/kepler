# Connectivity (SSM Tunnel)

## Why SSM

The CLI uses AWS Systems Manager Session Manager port forwarding for all connectivity to deployed instances. I think this is the right call, and here's why: it eliminates several categories of complexity that other approaches carry with them permanently.

- **No SSH key management.** Nothing to generate, store, rotate, or recover.
- **No public IPs or DNS.** The EC2 instance lives in a private subnet with no inbound exposure.
- **No security group inbound rules.** The attack surface at the network layer is zero.
- **No TLS certificate management.** Traffic is encrypted end-to-end by AWS.
- **No IP allowlist drift.** User IPs change, corporate networks move, VPN exits shift. SSM doesn't care about any of that.
- **Audit via CloudTrail.** Every session is logged with the IAM principal that initiated it, timestamp, duration, and source IP.

The trade-off is a hard dependency on AWS-specific tooling: the Session Manager plugin must be installed on the user's machine. The CLI detects its absence and provides clear installation instructions.

---

## Access Model

Access to a deployment is granted entirely through AWS IAM. Specifically, a user who can invoke `ssm:StartSession` against the deployment's EC2 instance can tunnel. Whoever cannot, cannot.

The CLI provides `kepler iam-policy` as a convenience for administrators to generate the appropriate policy. That policy grants:

- `s3:GetObject`, `s3:ListBucket` on the state bucket (scoped by resource ARN)
- `cloudformation:DescribeStacks`, `cloudformation:ListStacks` on stacks matching `kepler-*`
- `ec2:DescribeInstances`, `ec2:DescribeVpcs` filtered by the `kepler:managed=true` tag
- `ssm:StartSession` on EC2 instances tagged `kepler:managed=true`, with a condition restricting the SSM document to `AWS-StartPortForwardingSession` and the default shell session document
- `ssm:DescribeSessions`, `ssm:TerminateSession` scoped to the user's own sessions

There is no distinction between "deployer" and "user" in the standard policy. Any principal with the policy can tunnel. Destructive operations (`destroy`, `deploy`) require additional CloudFormation/IAM/EC2 permissions that are not part of the standard user policy, so they're naturally separated.

---

## Tunnel Lifecycle

```bash
$ kepler tunnel
✓ Resolving deployment my-deployment (region us-east-1)
✓ Instance i-0a1b2c3d4e5f... online and SSM-ready
✓ Starting port-forwarding session

Tunnel established:
  Local:  http://localhost:8080
  Remote: i-0a1b2c3d4e5f:8080
  Session ID: kepler-user-abc123def

Press Ctrl-C to disconnect.
```

Under the hood, the CLI invokes:

```
aws ssm start-session \
  --target i-0a1b2c3d4e5f \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}' \
  --region us-east-1
```

...with stdio inherited so the Session Manager plugin's output and the tunnel connection stream directly to the CLI process.

**Ctrl-C terminates cleanly:** the CLI sends SIGINT to the Session Manager plugin subprocess, the plugin calls `ssm:TerminateSession`, the tunnel closes, and the CLI exits 0.

**Crash handling:** if the CLI itself crashes, the SSM session may remain dangling for up to 20 minutes before AWS auto-reaps it. `kepler tunnel --cleanup` finds and terminates any dangling sessions for the current user.

**Flags:**

- `--local-port <n>`: bind the local end to port `<n>` instead of 8080.
- `--remote-port <n>`: forward to port `<n>` on the instance instead of 8080. Rarely needed.
- `--detach`: run the tunnel in the background, writing a PID file. Use `kepler tunnel stop` to terminate.

A user may run multiple `kepler tunnel` invocations simultaneously against different deployments. Each gets its own SSM session.

---

## Shell Access

`kepler ssh [deployment-name]` opens an interactive SSM shell session on the instance. Uses the default SSM document (`SSM-SessionManagerRunShell`) instead of the port-forwarding document. Useful for debugging, inspecting logs, and manual container interventions.

Behavior is identical to running `aws ssm start-session --target <instance-id>` directly, but with the deployment name resolution that the CLI already performs. You don't need to know the instance ID.
