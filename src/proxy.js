import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { selectRoute, rewriteBodyForRoute } from './config.js';

const MAX_CAPTURE_BYTES = 128 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const UNSAFE_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-length',
  'content-md5'
]);
const REDACTED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie'
]);

export async function handleProxyRequest(req, res, { config, logStore, fetchImpl = fetch }) {
  const startedAt = Date.now();
  const id = randomUUID();
  const requestBodyText = await readRequestBody(req);
  const requestBodyJson = parseJson(requestBodyText);
  const route = selectRoute(config, requestBodyJson);
  const outboundBodyJson = rewriteBodyForRoute(requestBodyJson, route);
  const outboundBodyText = outboundBodyJson === requestBodyJson
    ? requestBodyText
    : JSON.stringify(outboundBodyJson);
  const targetUrl = buildTargetUrl(route.baseUrl, req.url);
  const requestHeaders = buildOutboundHeaders(req.headers, route);

  const baseLog = {
    id,
    timestamp: new Date(startedAt).toISOString(),
    method: req.method,
    path: req.url,
    targetUrl,
    route: route.name,
    model: requestBodyJson?.model ?? null,
    routedModel: outboundBodyJson?.model ?? requestBodyJson?.model ?? null,
    request: {
      headers: redactHeaders(req.headers),
      body: captureText(requestBodyText)
    }
  };
  let upstreamStatus;
  let upstreamHeaders = {};
  let responseCapture = createCapture();

  try {
    const upstreamResponse = await fetchImpl(targetUrl, {
      method: req.method,
      headers: requestHeaders,
      body: shouldSendBody(req.method) ? outboundBodyText : undefined,
      duplex: 'half'
    });
    upstreamStatus = upstreamResponse.status;
    upstreamHeaders = sanitizeResponseHeaders(Object.fromEntries(upstreamResponse.headers.entries()));

    writeResponseHeaders(res, upstreamResponse);

    if (upstreamResponse.body) {
      const captureStream = new TransformCapture(responseCapture);
      await pipeline(upstreamResponse.body, captureStream, res);
    } else {
      res.end();
    }

    logStore.append({
      ...baseLog,
      status: upstreamStatus,
      durationMs: Date.now() - startedAt,
      response: {
        headers: upstreamHeaders,
        body: responseCapture.toJSON()
      }
    });
  } catch (error) {
    const status = upstreamStatus ?? (error.name === 'AbortError' ? 504 : 502);
    const body = JSON.stringify({
      error: {
        type: 'router_error',
        message: error.message
      }
    });
    let loggedBody = responseCapture.toJSON();

    if (!res.headersSent) {
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
      loggedBody = captureText(body);
    } else if (!res.writableEnded && !res.destroyed) {
      res.destroy?.(error);
    }

    logStore.append({
      ...baseLog,
      status,
      durationMs: Date.now() - startedAt,
      error: error.message,
      response: {
        headers: upstreamHeaders,
        body: loggedBody
      }
    });
  }
}

export function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => [
        name,
        REDACTED_HEADERS.has(name.toLowerCase()) ? '[redacted]' : value
      ])
  );
}

export function sanitizeResponseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(redactHeaders(headers))
      .filter(([name]) => !UNSAFE_RESPONSE_HEADERS.has(name.toLowerCase()))
  );
}

export function buildTargetUrl(baseUrl, requestUrl) {
  const base = new URL(baseUrl);
  const incoming = new URL(requestUrl, 'http://router.local');
  const basePath = base.pathname.replace(/\/$/, '');
  const incomingPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;

  base.pathname = `${basePath}${incomingPath}`;
  base.search = incoming.search;
  base.hash = '';

  return base.toString();
}

function buildOutboundHeaders(inboundHeaders, route) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(inboundHeaders)) {
    if (!value || HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'host') {
      continue;
    }

    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const apiKey = route.apiKey ?? process.env[route.apiKeyEnv];
  if (apiKey) {
    headers.set('x-api-key', apiKey);
  }
  headers.set('accept-encoding', 'identity');

  return headers;
}

function writeResponseHeaders(res, upstreamResponse) {
  const headers = {};

  for (const [name, value] of upstreamResponse.headers.entries()) {
    if (!UNSAFE_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  res.writeHead(upstreamResponse.status, headers);
}

function shouldSendBody(method) {
  return !['GET', 'HEAD'].includes(method);
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function captureText(text) {
  const bytes = Buffer.byteLength(text);
  const truncated = bytes > MAX_CAPTURE_BYTES;

  return {
    text: truncated ? Buffer.from(text).subarray(0, MAX_CAPTURE_BYTES).toString('utf8') : text,
    bytes,
    truncated
  };
}

function createCapture() {
  let bytes = 0;
  const chunks = [];

  return {
    push(chunk) {
      bytes += chunk.length;
      const remaining = MAX_CAPTURE_BYTES - chunks.reduce((sum, item) => sum + item.length, 0);
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
      }
    },
    toJSON() {
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        bytes,
        truncated: bytes > MAX_CAPTURE_BYTES
      };
    }
  };
}

class TransformCapture extends TransformStream {
  constructor(capture) {
    super({
      transform(chunk, controller) {
        const buffer = Buffer.from(chunk);
        capture.push(buffer);
        controller.enqueue(buffer);
      }
    });
  }
}
