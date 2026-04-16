import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const VERSION = loadVersion();
const PORT = Number.parseInt(process.env['PORT'] || '8080', 10);
const DEPLOYMENT_NAME = process.env['KEPLER_DEPLOYMENT_NAME'] || '';
const STATE_BUCKET = process.env['KEPLER_STATE_BUCKET'] || '';
const REGION = process.env['KEPLER_REGION'] || '';

const startTime = Date.now();

function uptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

function log(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n');
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const start = performance.now();
  const method = req.method || 'GET';
  const path = req.url || '/';

  let status = 200;
  let body: string;
  let contentType = 'application/json';

  switch (path) {
    case '/health': {
      body = JSON.stringify({ status: 'ok', version: VERSION, uptime: uptimeSeconds() });
      break;
    }
    case '/ready': {
      body = JSON.stringify({ ready: true });
      break;
    }
    case '/metrics': {
      contentType = 'text/plain';
      body = `# HELP kepler_core_uptime_seconds Time since server start in seconds\n# TYPE kepler_core_uptime_seconds counter\nkepler_core_uptime_seconds ${uptimeSeconds()}\n`;
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
  log({ level: 'info', msg: 'request', method, path, status, durationMs: Number(duration) });
}

const server = createServer(handleRequest);

function shutdown(signal: string): void {
  log({ level: 'info', msg: 'shutdown', signal, uptime: uptimeSeconds() });
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    log({ level: 'warn', msg: 'forced shutdown after timeout' });
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  log({
    level: 'info',
    msg: 'server started',
    version: VERSION,
    port: PORT,
    deploymentName: DEPLOYMENT_NAME,
    stateBucket: STATE_BUCKET,
    region: REGION,
  });
});
