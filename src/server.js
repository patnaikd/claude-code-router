import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRouterConfig } from './config.js';
import { LogStore } from './logStore.js';
import { handleProxyRequest } from './proxy.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');

export const defaultLogPath = join(rootDir, '.router-logs', 'calls.jsonl');

export async function createRouterServer({
  configPath = process.env.ROUTER_CONFIG,
  logPath = process.env.ROUTER_LOG_PATH ?? defaultLogPath,
  fetchImpl = fetch
} = {}) {
  const config = await loadRouterConfig(configPath);
  const logStore = new LogStore(logPath);
  await logStore.init();

  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/' || req.url.startsWith('/assets/') || req.url === '/app.js' || req.url === '/styles.css') {
        await serveStatic(req, res);
        return;
      }

      if (req.url.startsWith('/api/logs/stream')) {
        streamLogs(req, res, logStore);
        return;
      }

      if (req.url.startsWith('/api/logs')) {
        await serveLogs(req, res, logStore);
        return;
      }

      if (req.url.startsWith('/api/config')) {
        serveConfig(res, config);
        return;
      }

      await handleProxyRequest(req, res, { config, logStore, fetchImpl });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });

  server.routerConfig = config;
  server.logStore = logStore;

  return server;
}

export async function startRouterServer({
  port = Number(process.env.PORT ?? 8787),
  host = process.env.HOST ?? '127.0.0.1',
  configPath = process.env.ROUTER_CONFIG,
  logPath = process.env.ROUTER_LOG_PATH ?? defaultLogPath
} = {}) {
  const server = await createRouterServer({ configPath, logPath });
  await listen(server, port, host);

  return {
    server,
    port: server.address().port,
    host,
    url: `http://localhost:${server.address().port}`
  };
}

async function serveStatic(req, res) {
  const path = req.url === '/' ? '/index.html' : req.url;
  const filePath = join(publicDir, path);
  const body = await readFile(filePath);
  res.writeHead(200, { 'content-type': contentType(filePath) });
  res.end(body);
}

async function serveLogs(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const entries = await store.list({ limit });

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ entries }));
}

function serveConfig(res, config) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    defaultBaseUrl: config.default.baseUrl,
    routes: config.routes.map((route) => ({
      name: route.name,
      match: route.match,
      targetBaseUrl: route.target?.baseUrl
    }))
  }));
}

function streamLogs(req, res, store) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  const send = (entry) => {
    res.write(`event: log\n`);
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  store.on('entry', send);
  req.on('close', () => store.off('entry', send));
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main() {
  const started = await startRouterServer();
  console.log(`Claude Code router listening on ${started.url}`);
  console.log(`Set ANTHROPIC_BASE_URL=${started.url} before launching claude`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
