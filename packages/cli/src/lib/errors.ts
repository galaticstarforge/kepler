export class KeplerError extends Error {
  public readonly exitCode: number;
  public readonly hint?: string;

  constructor(message: string, options?: { exitCode?: number; hint?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'KeplerError';
    this.exitCode = options?.exitCode ?? 1;
    this.hint = options?.hint;
  }

  format(): string {
    let msg = `Error: ${this.message}`;
    if (this.hint) {
      msg += `\n  Hint: ${this.hint}`;
    }
    return msg;
  }
}

export class StateBucketNotFoundError extends KeplerError {
  constructor() {
    super('No state bucket found.', {
      hint: 'Run `kepler init` to create one, or `kepler discover` to find an existing one.',
    });
    this.name = 'StateBucketNotFoundError';
  }
}

export class DeploymentNotFoundError extends KeplerError {
  constructor(name: string) {
    super(`Deployment "${name}" not found.`, {
      hint: 'Run `kepler status` to see available deployments, or `kepler deploy <name>` to create one.',
    });
    this.name = 'DeploymentNotFoundError';
  }
}

export class NotInitializedError extends KeplerError {
  constructor() {
    super('Kepler is not initialized.', {
      hint: 'Run `kepler init` first.',
    });
    this.name = 'NotInitializedError';
  }
}

export class SsmPluginNotInstalledError extends KeplerError {
  constructor() {
    super('AWS Session Manager plugin is not installed.', {
      hint: 'Install it from https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
    });
    this.name = 'SsmPluginNotInstalledError';
  }
}
