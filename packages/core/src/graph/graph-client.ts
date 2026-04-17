import neo4j, { type Driver, type Session, type Record as Neo4jRecord } from 'neo4j-driver';

import { createLogger } from '../logger.js';

const log = createLogger('graph');

export interface GraphClientOptions {
  boltUrl: string;
  username?: string;
  password?: string;
  database?: string;
  maxPoolSize?: number;
}

export type AccessMode = 'READ' | 'WRITE';

export class GraphClient {
  private readonly driver: Driver;
  private readonly database: string;

  constructor(opts: GraphClientOptions) {
    if (!opts.boltUrl) throw new Error('GraphClient: boltUrl is required');
    const auth = opts.username
      ? neo4j.auth.basic(opts.username, opts.password ?? '')
      : undefined;
    this.driver = neo4j.driver(opts.boltUrl, auth, {
      maxConnectionPoolSize: opts.maxPoolSize ?? 50,
      userAgent: 'kepler-core',
    });
    this.database = opts.database ?? 'neo4j';
  }

  async connect(): Promise<void> {
    await this.driver.verifyConnectivity({ database: this.database });
  }

  async ping(): Promise<void> {
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.READ });
    try {
      await session.run('RETURN 1');
    } finally {
      await session.close();
    }
  }

  async applySchema(statements: readonly string[]): Promise<void> {
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      for (const stmt of statements) {
        await session.run(stmt);
      }
    } catch (error) {
      log.error('applySchema failed', { error: String(error) });
      throw error;
    } finally {
      await session.close();
    }
  }

  async runRead<T>(
    cypher: string,
    params: Record<string, unknown> = {},
    map: (r: Neo4jRecord) => T = (r) => r as unknown as T,
  ): Promise<T[]> {
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, params));
      return result.records.map((r) => map(r));
    } finally {
      await session.close();
    }
  }

  async runWrite<T>(
    cypher: string,
    params: Record<string, unknown> = {},
    map: (r: Neo4jRecord) => T = (r) => r as unknown as T,
  ): Promise<T[]> {
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      const result = await session.executeWrite((tx) => tx.run(cypher, params));
      return result.records.map((r) => map(r));
    } finally {
      await session.close();
    }
  }

  session(mode: AccessMode = 'WRITE'): Session {
    return this.driver.session({
      database: this.database,
      defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
