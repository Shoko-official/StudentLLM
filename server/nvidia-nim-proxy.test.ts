// @vitest-environment node
import { createServer, request, type ClientRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createViteServer } from 'vite';
import { createNimProxyHandler, NIM_PROXY_ERROR_HEADER, nvidiaNimProxy, type NimProxyOptions } from './nvidia-nim-proxy';

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

function send(port: number, path: string, init: { method?: string; headers?: Record<string, string | undefined>; body?: string; prefix?: string } = {}) {
  // Browsers send Sec-Fetch-Site on every fetch; tests opt out explicitly with `undefined`.
  const headers = Object.fromEntries(Object.entries({ host: `localhost:${port}`, 'sec-fetch-site': 'same-origin', ...init.headers }).filter(([, value]) => value !== undefined)) as Record<string, string>;
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `${init.prefix ?? '/nvidia-nim/v1'}${path}`, method: init.method ?? 'GET', headers }, (res) => {
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
    expect(response.headers[NIM_PROXY_ERROR_HEADER]).toBe('missing_key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('injects the credential server-side and forwards only to the fixed NVIDIA endpoint', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models', { headers: { authorization: 'Bearer from-browser', cookie: 'session=1' } });
    expect(response.status).toBe(200);
    expect(response.headers[NIM_PROXY_ERROR_HEADER]).toBeUndefined();
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
    ['a same-site fetch from another port', { 'sec-fetch-site': 'same-site' }],
    ['a client without browser fetch metadata, such as a script or tunnel', { 'sec-fetch-site': undefined }],
  ])('rejects %s', async (_label, headers) => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models', { headers });
    expect(response.status).toBe(403);
    expect(response.headers[NIM_PROXY_ERROR_HEADER]).toBe('forbidden');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback Host header such as a DNS-rebinding name', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models', { headers: { host: `attacker.example:${port}` } });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('only exposes the model, chat and text embedding routes', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    expect((await send(port, '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await send(port, '/../../evil')).status).toBe(404);
    const wrongMethod = await send(port, '/chat/completions');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe('POST');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards constrained text embeddings with the server credential and distinct modes', async () => {
    const fetchImpl = upstreamOk({ data: [] });
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    for (const input_type of ['passage', 'query']) {
      const payload = JSON.stringify({ model: 'nvidia/nemotron-3.5-embed-1b', input: ['Synthetic text'], input_type, modality: 'text', dimensions: 512, encoding_format: 'float', embedding_type: 'float', truncate: 'NONE' });
      expect((await send(port, '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })).status).toBe(200);
      const [url, init] = fetchImpl.mock.calls.at(-1)!;
      expect(url).toBe('https://integrate.api.nvidia.com/v1/embeddings');
      expect(init?.body).toBe(payload);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    }
  });

  it('rejects images, remote references, unsupported modes and oversized text before forwarding embeddings', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const valid = { model: 'nvidia/nemotron-3.5-embed-1b', input: ['text'], input_type: 'query', modality: 'text', dimensions: 512, encoding_format: 'float', embedding_type: 'float', truncate: 'NONE' };
    for (const patch of [{ input: ['data:image/png;base64,AA'] }, { input: ['data&#58;image&#47;png;base64,AA'] }, { input: ['<svg><path d="private-vector" /></svg>'] }, { input: ['<img src="image.png">'] }, { input: Array(33).fill('text') }, { input: ['x'.repeat(32769)] }, { input: [{ image: 'image.png' }] }, { input_type: 'other' }, { modality: 'image' }, { model: 'different-model' }, { truncate: 'END' }, { dimensions: 2048 }, { extra: 'https://other.example' }]) {
      expect((await send(port, '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...valid, ...patch }) })).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-JSON chat requests and stream values other than a boolean', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    expect((await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
    for (const stream of ['"true"', '1', 'null', '{}']) {
      expect((await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"stream":${stream}}` })).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('streamed chat', () => {
    const encoder = new TextEncoder();
    const streamedBody = JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const eventStreamHeaders = { 'content-type': 'text/event-stream; charset=utf-8' };
    const openStream = (port: number) => new Promise<{ res: IncomingMessage; req: ClientRequest }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/nvidia-nim/v1/chat/completions', method: 'POST', headers: { host: `localhost:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }, (res) => resolve({ res, req }));
      req.on('error', reject);
      req.end(streamedBody);
    });
    const nextData = (res: IncomingMessage) => new Promise<string>((resolve) => res.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))));
    const closed = (res: IncomingMessage) => new Promise<void>((resolve) => {
      res.on('error', () => undefined);
      res.resume();
      res.once('close', () => resolve());
    });
    const held = () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      return { body, controller };
    };

    it('sends each upstream chunk on as it arrives, before the upstream has finished', async () => {
      const upstream = held();
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(upstream.body, { status: 200, headers: { ...eventStreamHeaders, 'x-upstream-secret': 'internal' } }));
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const { res } = await openStream(port);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(eventStreamHeaders['content-type']);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-upstream-secret']).toBeUndefined();
      const first = nextData(res);
      upstream.controller.enqueue(encoder.encode('data: one\n\n'));
      expect(await first).toBe('data: one\n\n');
      const second = nextData(res);
      upstream.controller.enqueue(encoder.encode('data: two\n\n'));
      expect(await second).toBe('data: two\n\n');
      const ended = new Promise<void>((resolve) => res.once('end', () => resolve()));
      upstream.controller.close();
      await ended;
      expect(res.complete).toBe(true);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      expect(init?.body).toBe(streamedBody);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    });

    it('is not buffered by the real Vite dev server middleware stack', async () => {
      const upstream = held();
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(upstream.body, { status: 200, headers: eventStreamHeaders }));
      const vite = await createViteServer({ configFile: false, logLevel: 'silent', cacheDir: 'tmp/nim-proxy-test-cache', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [nvidiaNimProxy({ readKey: () => TEST_KEY, fetchImpl })] });
      try {
        server = createServer(vite.middlewares);
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        const { res } = await openStream((server.address() as AddressInfo).port);
        const first = nextData(res);
        upstream.controller.enqueue(encoder.encode('data: one\n\n'));
        expect(await first).toBe('data: one\n\n');
        const ended = new Promise<void>((resolve) => res.once('end', () => resolve()));
        upstream.controller.close();
        await ended;
      } finally {
        await vite.close();
      }
    });

    it('keeps the credential out of the streamed output', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('data: one\n\ndata: [DONE]\n\n', { status: 200, headers: eventStreamHeaders }));
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamedBody });
      expect(response.body).toBe('data: one\n\ndata: [DONE]\n\n');
      expect(response.body).not.toContain(TEST_KEY);
      expect(JSON.stringify(response.headers)).not.toContain(TEST_KEY);
    });

    it('aborts the upstream when the client disconnects', async () => {
      const upstream = held();
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => upstream.controller.error(new DOMException('aborted', 'AbortError')));
        return new Response(upstream.body, { status: 200, headers: eventStreamHeaders });
      });
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const { res, req } = await openStream(port);
      const first = nextData(res);
      upstream.controller.enqueue(encoder.encode('data: one\n\n'));
      await first;
      expect(signal?.aborted).toBe(false);
      req.destroy();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    });

    it('destroys the response at the size cap and never presents it as complete', async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
      });
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 200, headers: eventStreamHeaders }));
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const { res } = await openStream(port);
      let received = 0;
      res.on('data', (chunk: Buffer) => { received += chunk.length; });
      await closed(res);
      expect(res.complete).toBe(false);
      expect(received).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(cancelled).toBe(true);
    });

    it('destroys the response when the upstream fails after the headers were sent', async () => {
      const upstream = held();
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(upstream.body, { status: 200, headers: eventStreamHeaders }));
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const { res } = await openStream(port);
      const first = nextData(res);
      upstream.controller.enqueue(encoder.encode('data: one\n\n'));
      await first;
      upstream.controller.error(new TypeError(`broken with ${TEST_KEY}`));
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      await closed(res);
      expect(res.complete).toBe(false);
      expect(text).toBe('');
    });

    it('keeps the timeout total: a stream still running at the deadline is destroyed', async () => {
      const upstream = held();
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        init?.signal?.addEventListener('abort', () => upstream.controller.error(new DOMException('aborted', 'AbortError')));
        return new Response(upstream.body, { status: 200, headers: eventStreamHeaders });
      });
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl, timeoutMs: 40 });
      const { res } = await openStream(port);
      upstream.controller.enqueue(encoder.encode('data: one\n\n'));
      await closed(res);
      expect(res.complete).toBe(false);
    });

    it('relays a non-ok answer to a streamed request through the buffered path', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } }));
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamedBody });
      expect(response.status).toBe(429);
      expect(JSON.parse(response.body).error.message).toBe('rate limited');
      expect(response.headers[NIM_PROXY_ERROR_HEADER]).toBeUndefined();
    });

    it('buffers a JSON answer to a streamed request, since a server may ignore the flag', async () => {
      const fetchImpl = upstreamOk({ choices: [{ message: { content: 'ok' } }] });
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamedBody });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).choices[0].message.content).toBe('ok');
    });

    it('reports a refused upstream connection as a JSON error before any header was sent', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError('connect failed'); });
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamedBody });
      expect(response.status).toBe(502);
      expect(response.headers[NIM_PROXY_ERROR_HEADER]).toBe('unreachable');
    });

    it('leaves a request that did not ask for a stream buffered, with its accept header unchanged', async () => {
      for (const payload of ['{"stream":false}', '{}']) {
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response('data: ignored\n\n', { status: 200, headers: eventStreamHeaders }));
        const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
        const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
        expect(response.body).toBe('data: ignored\n\n');
        expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('accept')).toBe('application/json');
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      server = undefined;
    });

    it('still refuses an oversized buffered answer to a streamed request', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 500 }));
      const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
      const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamedBody });
      expect(response.status).toBe(502);
    });
  });

  it('never returns the credential, even when NVIDIA is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError(`connect failed with ${TEST_KEY}`); });
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models');
    expect(response.status).toBe(502);
    expect(response.body).not.toContain(TEST_KEY);
    expect(JSON.stringify(response.headers)).not.toContain(TEST_KEY);
  });

  it('rejects an oversized request and closes the connection', async () => {
    const fetchImpl = upstreamOk();
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"pad":"${'x'.repeat(8 * 1024 * 1024)}"}` });
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe('close');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an oversized upstream response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 200 }));
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl });
    const response = await send(port, '/models');
    expect(response.status).toBe(502);
    expect(response.body.length).toBeLessThan(1024);
  });

  it('times out an upstream that stalls while sending its body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    }), { status: 200 }));
    const port = await startProxy({ readKey: () => TEST_KEY, fetchImpl, timeoutMs: 20 });
    const response = await send(port, '/models');
    expect(response.status).toBe(504);
  });

  it('serves the route through the real Vite dev server middleware stack', async () => {
    const fetchImpl = upstreamOk();
    const vite = await createViteServer({ configFile: false, logLevel: 'silent', cacheDir: 'tmp/nim-proxy-test-cache', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [nvidiaNimProxy({ readKey: () => TEST_KEY, fetchImpl })] });
    try {
      server = createServer(vite.middlewares);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      expect((await send(port, '/models')).status).toBe(200);
      expect((await send(port, '/models', { prefix: '/NVIDIA-NIM/V1' })).status).toBe(200);
      expect((await send(port, '/models', { headers: { 'sec-fetch-site': undefined } })).status).toBe(403);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await vite.close();
    }
  });

  it('is only applied to the dev server, never to builds', () => {
    expect(nvidiaNimProxy().apply).toBe('serve');
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
