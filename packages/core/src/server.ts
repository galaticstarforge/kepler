import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Logger } from './logger.js';
import type { AuthStore } from './mcp/auth-store.js';
import type { McpRequest, McpResponse, RequestMeta } from './mcp/mcp-router.js';
import { McpRouter } from './mcp/mcp-router.js';
import type { RateLimiter } from './mcp/rate-limiter.js';

export interface ReadinessProbeResult {
  ready: boolean;
  details?: Record<string, unknown>;
}

export type ReadinessProbe = () => Promise<ReadinessProbeResult>;

export interface ServerDeps {
  version: string;
  port: number;
  deploymentName: string;
  router: McpRouter;
  logger: Logger;
  readinessProbe?: ReadinessProbe;
  authStore?: AuthStore;
  rateLimiter?: RateLimiter;
}

/** Extract `Bearer <token>` from the Authorization header. */
function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function mcpErrorResponse(
  id: string | number | undefined,
  code: number,
  message: string,
  httpStatus: number,
): { body: string; status: number } {
  const payload: McpResponse = { id, error: { code, message } };
  return { body: JSON.stringify(payload), status: httpStatus };
}

export function createHttpServer(deps: ServerDeps) {
  const startTime = Date.now();
  // Active SSE connections: sessionId → response stream.
  const sseConnections = new Map<string, ServerResponse>();

  function uptimeSeconds(): number {
    return Math.floor((Date.now() - startTime) / 1000);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = performance.now();
    const method = req.method || 'GET';
    const rawPath = req.url || '/';
    // Strip query string for routing.
    const path = rawPath.split('?')[0] ?? rawPath;

    let status = 200;
    let body: string;
    let contentType = 'application/json';

    switch (path) {
      case '/health': {
        body = JSON.stringify({ status: 'ok', version: deps.version, uptime: uptimeSeconds() });
        break;
      }
      case '/ready': {
        if (deps.readinessProbe) {
          const probe = await deps.readinessProbe();
          status = probe.ready ? 200 : 503;
          body = JSON.stringify(
            probe.details ? { ready: probe.ready, ...probe.details } : { ready: probe.ready },
          );
        } else {
          body = JSON.stringify({ ready: true });
        }
        break;
      }
      case '/metrics': {
        contentType = 'text/plain';
        body = [
          '# HELP kepler_core_uptime_seconds Time since server start in seconds',
          '# TYPE kepler_core_uptime_seconds counter',
          `kepler_core_uptime_seconds ${uptimeSeconds()}`,
        ].join('\n') + '\n';
        break;
      }

      case '/mcp/sse': {
        if (method !== 'GET') {
          status = 405;
          body = JSON.stringify({ error: 'Method not allowed. Use GET for SSE.' });
          break;
        }
        // Auth check for SSE connections.
        if (deps.authStore?.enabled) {
          const token = extractBearer(req);
          if (!token) {
            const { body: b, status: s } = mcpErrorResponse(
              undefined, -32_001, 'Unauthorized: missing Bearer token', 401,
            );
            res.writeHead(s, { 'Content-Type': 'application/json' });
            res.end(b);
            return;
          }
          const validated = deps.authStore.validate(token);
          if (!validated) {
            const { body: b, status: s } = mcpErrorResponse(
              undefined, -32_001, 'Unauthorized: invalid or unknown token', 401,
            );
            res.writeHead(s, { 'Content-Type': 'application/json' });
            res.end(b);
            return;
          }
        }

        const sessionId = randomUUID();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Session-Id': sessionId,
        });

        // Send endpoint event so MCP clients know where to POST requests.
        res.write(`event: endpoint\ndata: ${JSON.stringify({ url: '/mcp', sessionId })}\n\n`);

        sseConnections.set(sessionId, res);

        // Keep-alive heartbeat every 30 s.
        const heartbeat = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(heartbeat);
          } else {
            res.write(': keepalive\n\n');
          }
        }, 30_000);

        req.on('close', () => {
          clearInterval(heartbeat);
          sseConnections.delete(sessionId);
          deps.logger.debug('sse connection closed', { sessionId });
        });

        const duration = (performance.now() - start).toFixed(2);
        deps.logger.info('request', { method, path, status: 200, durationMs: Number(duration) });
        return;
      }

      case '/mcp': {
        if (method !== 'POST') {
          status = 405;
          body = JSON.stringify({ error: 'Method not allowed. Use POST.' });
          break;
        }

        // Auth enforcement.
        let requestMeta: RequestMeta = {};
        if (deps.authStore?.enabled) {
          const token = extractBearer(req);
          if (!token) {
            const { body: b, status: s } = mcpErrorResponse(
              undefined, -32_001, 'Unauthorized: missing Bearer token', 401,
            );
            res.writeHead(s, { 'Content-Type': 'application/json' });
            res.end(b);
            return;
          }
          const validated = deps.authStore.validate(token);
          if (!validated) {
            const { body: b, status: s } = mcpErrorResponse(
              undefined, -32_001, 'Unauthorized: invalid or unknown token', 401,
            );
            res.writeHead(s, { 'Content-Type': 'application/json' });
            res.end(b);
            return;
          }

          // Rate-limit check.
          if (deps.rateLimiter) {
            const rl = deps.rateLimiter.check(validated.name);
            if (!rl.allowed) {
              const msg = `Rate limited. Retry after ${rl.retryAfter} second(s).`;
              const { body: b, status: s } = mcpErrorResponse(undefined, -32_029, msg, 429);
              res.writeHead(s, {
                'Content-Type': 'application/json',
                'Retry-After': String(rl.retryAfter),
              });
              res.end(b);
              return;
            }
          }

          requestMeta = { scopes: validated.scopes };
        }

        const traceId = randomUUID();
        requestMeta.traceId = traceId;

        const mcpBody = await readBody(req);
        let mcpRequest: McpRequest;
        try {
          mcpRequest = JSON.parse(mcpBody) as McpRequest;
        } catch {
          status = 400;
          body = JSON.stringify({ error: 'Invalid JSON' });
          break;
        }

        deps.logger.debug('mcp request', { traceId, method: mcpRequest.method, id: mcpRequest.id });

        const mcpResponse: McpResponse = await deps.router.handleRequest(mcpRequest, requestMeta);
        if (mcpResponse.httpStatus) {
          status = mcpResponse.httpStatus;
        } else if (mcpResponse.error) {
          status = 400;
        } else {
          status = 200;
        }
        const wireResponse: Record<string, unknown> = { ...mcpResponse };
        delete wireResponse['httpStatus'];
        body = JSON.stringify(wireResponse);

        // If request came from an SSE session, also forward response over the stream.
        const sessionId = req.headers['x-session-id'] as string | undefined;
        if (sessionId) {
          const sseRes = sseConnections.get(sessionId);
          if (sseRes && !sseRes.writableEnded) {
            sseRes.write(`event: message\ndata: ${body}\n\n`);
          }
        }
        break;
      }

      default: {
        status = 404;
        body = JSON.stringify({ error: 'not found' });
        break;
      }
    }

    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);

    const duration = (performance.now() - start).toFixed(2);
    deps.logger.info('request', { method, path, status, durationMs: Number(duration) });
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      deps.logger.error('unhandled request error', { error: String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal server error' }));
      }
    });
  });

  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
