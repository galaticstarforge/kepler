# Distribution and Installation

## Package

The CLI is published to the npm registry as `@kepler/cli`. Installation:

```bash
npm install -g @kepler/cli
```

The package is scoped (`@kepler/*`) and public. Publishing uses npm provenance to prove builds originated from the project's GitHub Actions workflow.

The CLI is one of several packages in the Kepler monorepo but publishes independently. The other packages (`@kepler/core` the runtime, `@kepler/installer` the CDK stacks consumed internally, `@kepler/plugin-sdk` for plugin authors, and `@kepler/shared` internal utilities) are implementation details. Users only install the CLI.

---

## Prerequisites

The CLI requires the following on the user's machine:

- **Node.js 20 or later.** The CLI is a pure Node application with no native dependencies.
- **AWS credentials** configured in any form the AWS SDK recognizes: `~/.aws/credentials`, environment variables, IAM Identity Center SSO, EC2 instance roles, etc. The CLI does not prompt for or store credentials.
- **AWS CLI v2.** Required for the Session Manager plugin, which the CLI shells out to for tunneling.
- **Session Manager plugin for AWS CLI.** Installed separately from AWS CLI v2. The `tunnel` and `ssh` commands require it. The CLI detects its absence and prints platform-specific installation instructions.

Optional:

- **Docker.** Not required for CLI operations, but required if the user wants to build plugins from source locally before upload.

---

## Platform Support

**Tier 1** (tested and supported):

- macOS (Apple Silicon and Intel)
- Linux (x86_64, kernel 5.x+)
- Windows 11 with WSL 2 (Ubuntu or similar)

**Tier 2** (expected to work, not actively tested):

- Native Windows 11 (PowerShell)
- Linux (ARM64)

File system paths follow platform conventions. On macOS and Linux, local config lives at `~/.config/kepler/`. On Windows, at `%APPDATA%\kepler\`. The `xdg-basedir` package handles XDG compliance on Linux. The CLI uses a single codebase with platform-specific branches only where unavoidable: path separators and shell invocation for the SSM plugin.

---

## Offline Behavior

The CLI requires network access for every meaningful operation because almost everything involves AWS API calls. Commands that are purely local work offline: `version`, `config get`, and `iam-policy` in print-only mode. The CLI does not cache AWS API results between invocations. Each run makes fresh calls.
