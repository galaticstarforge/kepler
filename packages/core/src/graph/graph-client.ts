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

  /**
   * Returns the running server's version string (e.g. `'5.14.0'`). Uses the
   * `dbms.components()` procedure which is always available in Neo4j 3.x+.
   */
  async serverVersion(): Promise<string> {
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run('CALL dbms.components() YIELD versions RETURN versions[0] AS version');
      const record = result.records[0];
      if (!record) throw new Error('dbms.components() returned no rows');
      const version = record.get('version');
      if (typeof version !== 'string' || version.length === 0) {
        throw new Error('dbms.components() returned no version string');
      }
      return version;
    } finally {
      await session.close();
    }
  }

  /**
   * Returns state information for the named indexes. Missing indexes are
   * omitted. `state` values mirror Neo4j's `SHOW INDEXES` output
   * (`ONLINE`, `POPULATING`, `FAILED`).
   */
  async indexStates(names: readonly string[]): Promise<Array<{ name: string; state: string; type: string }>> {
    if (names.length === 0) return [];
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(
        'SHOW INDEXES YIELD name, state, type WHERE name IN $names RETURN name, state, type',
        { names: [...names] },
      );
      return result.records.map((r) => ({
        name: String(r.get('name')),
        state: String(r.get('state')),
        type: String(r.get('type')),
      }));
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
