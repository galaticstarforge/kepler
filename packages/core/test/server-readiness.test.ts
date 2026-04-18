import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { McpRouter } from '../src/mcp/mcp-router.js';
import type { HandlerContext } from '../src/mcp/types.js';
import { createHttpServer, type ReadinessProbe } from '../src/server.js';

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function startServer(readinessProbe?: ReadinessProbe) {
  const router = new McpRouter({ logger: silentLogger() } as unknown as HandlerContext);
  const server = createHttpServer({
    version: 'test',
    port: 0,
    deploymentName: 'test',
    router,
    logger: silentLogger(),
    readinessProbe,
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, rej) => {
            server.close((err) => (err ? rej(err) : r()));
          }),
      });
    });
  });
}

let server: Awaited<ReturnType<typeof startServer>>;

afterEach(async () => {
  if (server) await server.close();
});

describe('HTTP server /ready probe', () => {
  it('returns 200 when the probe reports ready', async () => {
    server = await startServer(async () => ({
      ready: true,
      details: { vectorIndexes: [{ name: 'symbol_summary_embedding', state: 'ONLINE' }] },
    }));

    const resp = await fetch(`${server.url}/ready`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ready: boolean; vectorIndexes: Array<{ state: string }> };
    expect(body.ready).toBe(true);
    expect(body.vectorIndexes[0]!.state).toBe('ONLINE');
  });

  it('returns 503 when the probe reports not-ready', async () => {
    server = await startServer(async () => ({
      ready: false,
      details: { vectorIndexes: [{ name: 'symbol_summary_embedding', state: 'POPULATING' }] },
    }));

    const resp = await fetch(`${server.url}/ready`);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it('defaults to 200 with ready:true when no probe is supplied', async () => {
    server = await startServer();
    const resp = await fetch(`${server.url}/ready`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ready: boolean };
    expect(body.ready).toBe(true);
  });
});
