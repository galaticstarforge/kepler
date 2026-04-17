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

export class AwsCredentialsError extends KeplerError {
  constructor(cause?: unknown) {
    super('AWS credentials not configured or expired.', {
      hint: 'Configure credentials via environment variables, AWS CLI profiles, or SSO. See `kepler iam-policy` for required permissions.',
      cause,
    });
    this.name = 'AwsCredentialsError';
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

export class DeploymentInProgressError extends KeplerError {
  constructor(name: string, status: string) {
    super(`Deployment "${name}" is in transitional state: ${status}.`, {
      hint: 'Wait for the current operation to complete and try again.',
    });
    this.name = 'DeploymentInProgressError';
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

export class DocumentNotFoundError extends KeplerError {
  constructor(path: string) {
    super(`Document not found: "${path}".`, {
      hint: 'Check the path and try again, or use `docs.list` to see available documents.',
    });
    this.name = 'DocumentNotFoundError';
  }
}

export class DocumentStoreError extends KeplerError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DocumentStoreError';
  }
}

export class SemanticIndexError extends KeplerError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SemanticIndexError';
  }
}

export class EnrichmentError extends KeplerError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'EnrichmentError';
  }
}

export class FrontmatterValidationError extends KeplerError {
  constructor(path: string, issues: string[]) {
    super(`Frontmatter validation failed for "${path}": ${issues.join('; ')}`, {
      hint: 'Frontmatter errors are non-fatal — the document will still be stored with reduced metadata.',
    });
    this.name = 'FrontmatterValidationError';
  }
}
