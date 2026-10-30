// @vitest-environment node
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNimProxyHandler, type NimProxyOptions } from './nvidia-nim-proxy';

const TEST_KEY = 'nvapi-test-value-not-a-real-key';
let server: Server | undefined;

async function startProxy(options: NimProxyOptions) {
  const handler = createNimProxyHandler(options);
  server = createServer((req, res) => {
    // Mirror connect's prefix stripping for routes mounted under /nvidia-nim/v1.
    req.url = req.url?.replace(/^\/nvidia-nim\/v1/, '') || '/';
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function send(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/nvidia-nim/v1${path}`, method: init.method ?? 'GET', headers: { host: `localhost:${port}`, ...init.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

function upstreamOk(body: unknown = { data: [{ id: 'openai/gpt-oss-20b' }] }) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('NVIDIA NIM dev proxy', () => {
  it('reports a missing credential without calling NVIDIA', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => undefined, fetchImpl });
    const response = await send(port, '/models');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.message).toMatch(/NVIDIA_API_KEY is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('injects the credential server-side and forwards only to the fixed NVIDIA endpoint', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models', { headers: { authorization: 'Bearer from-browser', cookie: 'session=1', 'sec-fetch-site': 'same-origin' } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data[0].id).toBe('openai/gpt-oss-20b');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/models');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(Object.keys(headers)).not.toContain('cookie');
    expect(init?.redirect).toBe('error');
  });

  it('forwards chat completions as JSON', async () => {
    const fetchImpl = upstreamOk({ choices: [{ message: { content: 'ok' } }] });
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const payload = JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` }, body: payload });
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(payload);
  });

  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
  ])('rejects %s', async (_label, headers) => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models', { headers });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback Host header such as a DNS-rebinding name', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models', { headers: { host: `attacker.example:${port}` } });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('only exposes the two routes the app needs', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    expect((await send(port, '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await send(port, '/../../evil')).status).toBe(404);
    const wrongMethod = await send(port, '/chat/completions');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe('POST');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-JSON and streaming chat requests', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    expect((await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
    expect((await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}' })).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never returns the credential, even when NVIDIA is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError(`connect failed with ${TEST_KEY}`); });
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models');
    expect(response.status).toBe(502);
    expect(response.body).not.toContain(TEST_KEY);
    expect(JSON.stringify(response.headers)).not.toContain(TEST_KEY);
  });

  it('times out a slow upstream', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl, timeoutMs: 20 });
    const response = await send(port, '/models');
    expect(response.status).toBe(504);
  });
});
