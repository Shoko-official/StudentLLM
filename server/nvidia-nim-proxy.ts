import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import nimModels from '../src/lib/nvidia-nim-models.json' with { type: 'json' };

export const NIM_PROXY_PREFIX = '/nvidia-nim/v1';
// Fixed on purpose: the credential must never be forwarded to a configurable host.
const NIM_UPSTREAM = 'https://integrate.api.nvidia.com/v1';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
const ROUTES: Record<string, 'GET' | 'POST'> = { '/models': 'GET', '/chat/completions': 'POST', '/embeddings': 'POST' };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Lets the app tell the proxy's own refusals apart from statuses relayed from NVIDIA. */
export const NIM_PROXY_ERROR_HEADER = 'x-studentllm-proxy-error';
export type NimProxyErrorCode = 'missing_key' | 'forbidden' | 'not_found' | 'method' | 'bad_request' | 'too_large' | 'unreachable' | 'timeout' | 'failed';

export type NimProxyOptions = {
  /** Defaults to the dev server's own environment, captured when it started; .env files never reach it. */
  readKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

class ProxyError extends Error {
  constructor(readonly status: number, readonly code: NimProxyErrorCode, message: string) {
    super(message);
  }
}

function sendProxyError(res: ServerResponse, error: ProxyError) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = error.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader(NIM_PROXY_ERROR_HEADER, error.code);
  // An unread request body would desynchronise a keep-alive connection.
  if (error.code === 'too_large') res.setHeader('connection', 'close');
  res.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
}

function hostName(host: string | undefined) {
  if (!host) return '';
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

// Only the developer's own browser tab may spend the credential: no LAN clients, no other sites, no rebinding,
// and no header-less clients such as scripts or tunnels that rewrite Host to localhost.
function assertLocalSameOrigin(req: IncomingMessage) {
  const remote = req.socket?.remoteAddress;
  if (remote && !LOOPBACK_ADDRESSES.has(remote)) throw new ProxyError(403, 'forbidden', 'NVIDIA NIM is only available from this computer.');
  const host = req.headers.host;
  if (!LOOPBACK_HOSTS.has(hostName(host).toLowerCase())) throw new ProxyError(403, 'forbidden', 'NVIDIA NIM is only available on a loopback address.');
  if (req.headers['sec-fetch-site'] !== 'same-origin') throw new ProxyError(403, 'forbidden', 'Only same-origin browser requests are allowed.');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) throw new ProxyError(403, 'forbidden', 'Cross-site requests are not allowed.');
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new ProxyError(413, 'too_large', 'The request is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validateChatBody(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProxyError(400, 'bad_request', 'The request body must be JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProxyError(400, 'bad_request', 'The request body must be a JSON object.');
  const stream = (parsed as { stream?: unknown }).stream;
  if (stream !== undefined && stream !== false) throw new ProxyError(400, 'bad_request', 'Streaming responses are not supported.');
  return raw;
}

function validateEmbeddingBody(raw: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProxyError(400, 'bad_request', 'Text embeddings require valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProxyError(400, 'bad_request', 'Text embeddings require an object.');
  const body = value as Record<string, unknown>;
  const keys = new Set(['model', 'input', 'input_type', 'modality', 'dimensions', 'encoding_format', 'embedding_type', 'truncate']);
  if (Object.keys(body).some(key => !keys.has(key)) || body.model !== nimModels.embeddingModel || !['query', 'passage'].includes(String(body.input_type)) || body.modality !== 'text' || body.dimensions !== 512 || body.encoding_format !== 'float' || body.embedding_type !== 'float' || body.truncate !== 'NONE'
    || !Array.isArray(body.input) || body.input.length < 1 || body.input.length > 32 || body.input.some(input => typeof input !== 'string' || !input.trim() || Buffer.byteLength(input, 'utf8') > 32_768 || /data:image\/|<img\b/i.test(input))) {
    throw new ProxyError(400, 'bad_request', 'Only bounded text retrieval embeddings are supported.');
  }
  return raw;
}

async function readUpstreamBody(response: Response) {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProxyError(502, 'failed', 'NVIDIA NIM returned a response that is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createNimProxyHandler(options: NimProxyOptions = {}) {
  const readKey = options.readKey ?? (() => process.env.NVIDIA_API_KEY);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abortOnDisconnect);
    try {
      assertLocalSameOrigin(req);
      const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
      const method = ROUTES[path];
      if (!method) throw new ProxyError(404, 'not_found', 'This NVIDIA NIM route is not available.');
      if (req.method !== method) {
        res.setHeader('allow', method);
        throw new ProxyError(405, 'method', 'Method not allowed.');
      }
      let body: string | undefined;
      if (method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new ProxyError(415, 'bad_request', 'The request body must be JSON.');
        const raw = await readBody(req);
        body = path === '/embeddings' ? validateEmbeddingBody(raw) : validateChatBody(raw);
      }
      const key = readKey()?.trim();
      if (!key) throw new ProxyError(503, 'missing_key', 'NVIDIA_API_KEY is not set. Set it in your Windows User environment, then restart the dev server.');

      timer = setTimeout(() => controller.abort(), timeoutMs);
      let upstream: Response;
      let upstreamBody: Buffer;
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
        upstreamBody = await readUpstreamBody(upstream);
      } catch (error) {
        if (error instanceof ProxyError) throw error;
        if (controller.signal.aborted) throw new ProxyError(504, 'timeout', 'NVIDIA NIM did not respond in time.');
        throw new ProxyError(502, 'unreachable', 'Could not reach NVIDIA NIM.');
      }
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(upstreamBody);
    } catch (error) {
      sendProxyError(res, error instanceof ProxyError ? error : new ProxyError(502, 'failed', 'NVIDIA NIM request failed.'));
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
