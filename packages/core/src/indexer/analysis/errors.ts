export class NotImplementedError extends Error {
  constructor(feature: string, docRef?: string) {
    const suffix = docRef ? ` See ${docRef}.` : '';
    super(`${feature} is documented but not yet implemented.${suffix}`);
    this.name = 'NotImplementedError';
  }
}
