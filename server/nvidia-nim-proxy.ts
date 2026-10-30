import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export const NIM_PROXY_PREFIX = '/nvidia-nim/v1';
// Fixed on purpose: the credential must never be forwarded to a configurable host.
const NIM_UPSTREAM = 'https://integrate.api.nvidia.com/v1';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
const ROUTES: Record<string, 'GET' | 'POST'> = { '/models': 'GET', '/chat/completions': 'POST' };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export type NimProxyOptions = {
  /** Reads the credential per request so a restarted shell is not needed after rotation. */
  readKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

class ProxyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function hostName(host: string | undefined) {
  if (!host) return '';
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

// Only the developer's own browser tab may spend the credential: no LAN clients, no other sites, no rebinding.
function assertLocalSameOrigin(req: IncomingMessage) {
  const remote = req.socket?.remoteAddress;
  if (remote && !LOOPBACK_ADDRESSES.has(remote)) throw new ProxyError(403, 'NVIDIA NIM is only available from this computer.');
  const host = req.headers.host;
  if (!LOOPBACK_HOSTS.has(hostName(host).toLowerCase())) throw new ProxyError(403, 'NVIDIA NIM is only available on a loopback address.');
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') throw new ProxyError(403, 'Cross-site requests are not allowed.');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) throw new ProxyError(403, 'Cross-site requests are not allowed.');
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new ProxyError(413, 'The request is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validateChatBody(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProxyError(400, 'The request body must be JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProxyError(400, 'The request body must be a JSON object.');
  if ((parsed as { stream?: unknown }).stream === true) throw new ProxyError(400, 'Streaming responses are not supported.');
  return raw;
}

async function readUpstreamText(response: Response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new ProxyError(502, 'NVIDIA NIM returned a response that is too large.');
  return text;
}

export function createNimProxyHandler(options: NimProxyOptions = {}) {
  const readKey = options.readKey ?? (() => process.env.NVIDIA_API_KEY);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abortOnDisconnect);
    try {
      assertLocalSameOrigin(req);
      const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
      const method = ROUTES[path];
      if (!method) throw new ProxyError(404, 'This NVIDIA NIM route is not available.');
      if (req.method !== method) {
        res.setHeader('allow', method);
        throw new ProxyError(405, 'Method not allowed.');
      }
      let body: string | undefined;
      if (method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new ProxyError(415, 'The request body must be JSON.');
        body = validateChatBody(await readBody(req));
      }
      const key = readKey()?.trim();
      if (!key) throw new ProxyError(503, 'NVIDIA_API_KEY is not set. Set it in your Windows User environment, then restart the dev server.');

      let upstream: Response;
      try {
        upstream = await fetchImpl(`${NIM_UPSTREAM}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${key}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (controller.signal.aborted) throw new ProxyError(504, 'NVIDIA NIM did not respond in time.');
        throw new ProxyError(502, error instanceof Error && error.name === 'TypeError' ? 'Could not reach NVIDIA NIM.' : 'NVIDIA NIM request failed.');
      }
      const text = await readUpstreamText(upstream);
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(text);
    } catch (error) {
      if (error instanceof ProxyError) sendJson(res, error.status, { error: { message: error.message } });
      else sendJson(res, 502, { error: { message: 'NVIDIA NIM request failed.' } });
    } finally {
      clearTimeout(timer);
      res.off('close', abortOnDisconnect);
    }
  };
}

/** Dev-server-only route that lets the browser use NVIDIA NIM without ever seeing the credential. */
export function nvidiaNimProxy(options: NimProxyOptions = {}): Plugin {
  const handler = createNimProxyHandler(options);
  return {
    name: 'studentllm-nvidia-nim-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(NIM_PROXY_PREFIX, (req, res) => void handler(req, res));
    },
  };
}
