import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Logger } from './logger.js';
import { McpRouter, type McpRequest, type McpResponse } from './mcp/mcp-router.js';

export interface ServerDeps {
  version: string;
  port: number;
  deploymentName: string;
  router: McpRouter;
  logger: Logger;
}

export function createHttpServer(deps: ServerDeps) {
  const startTime = Date.now();

  function uptimeSeconds(): number {
    return Math.floor((Date.now() - startTime) / 1000);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = performance.now();
    const method = req.method || 'GET';
    const path = req.url || '/';

    let status = 200;
    let body: string;
    let contentType = 'application/json';

    switch (path) {
      case '/health': {
        body = JSON.stringify({ status: 'ok', version: deps.version, uptime: uptimeSeconds() });
        break;
      }
      case '/ready': {
        body = JSON.stringify({ ready: true });
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
      case '/mcp': {
        if (method !== 'POST') {
          status = 405;
          body = JSON.stringify({ error: 'Method not allowed. Use POST.' });
          break;
        }

        const mcpBody = await readBody(req);
        let mcpRequest: McpRequest;
        try {
          mcpRequest = JSON.parse(mcpBody) as McpRequest;
        } catch {
          status = 400;
          body = JSON.stringify({ error: 'Invalid JSON' });
          break;
        }

        const mcpResponse: McpResponse = await deps.router.handleRequest(mcpRequest);
        status = mcpResponse.error ? 400 : 200;
        body = JSON.stringify(mcpResponse);
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
