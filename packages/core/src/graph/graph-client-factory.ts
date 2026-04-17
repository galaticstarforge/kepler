import type { GraphConfig } from '../config.js';

import { GraphClient } from './graph-client.js';

export function createGraphClient(config: GraphConfig): GraphClient {
  if (!config.bolt) throw new Error('storage.graph.bolt is required');
  return new GraphClient({
    boltUrl: config.bolt,
    username: config.username,
    password: config.password,
    database: config.database,
    maxPoolSize: config.maxPoolSize ?? 50,
  });
}
