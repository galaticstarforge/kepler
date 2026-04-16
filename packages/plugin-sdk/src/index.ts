export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  repository?: string;
  languages?: string[];
  frameworks?: string[];
}

export interface PluginContext {
  deploymentName: string;
  region: string;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}

export interface Plugin {
  metadata: PluginMetadata;
  initialize(ctx: PluginContext): Promise<void>;
  destroy(): Promise<void>;
  onFileRead?(filePath: string, content: string): Promise<string>;
  onGraphEnrich?(graphUri: string): Promise<void>;
}

/**
 * Define a plugin. Returns the plugin unchanged — this is a typed identity
 * function that provides autocomplete and validation for plugin authors.
 *
 * @unstable Plugin contract is unstable in v0.0.1.
 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
