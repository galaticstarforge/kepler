export interface Plugin {
  name: string;
  version: string;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}
