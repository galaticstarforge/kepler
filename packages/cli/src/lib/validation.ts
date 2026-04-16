const DEPLOYMENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export function validateDeploymentName(name: string): void {
  if (name.length < 2 || name.length > 63) {
    throw new Error(
      `Deployment name must be 2-63 characters long. Got ${name.length}.`,
    );
  }
  if (!DEPLOYMENT_NAME_RE.test(name)) {
    throw new Error(
      'Deployment name must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number.',
    );
  }
}
