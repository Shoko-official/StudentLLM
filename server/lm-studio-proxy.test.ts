// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { endResponseWhenUpstreamDies } from './lm-studio-proxy';

let upstream: Server | undefined;
let front: Server | undefined;
let vite: ViteDevServer | undefined;

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server | undefined) => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
});

async function proxied(answer: (res: ServerResponse) => void) {
  upstream = createServer((_req, res) => answer(res));
  const target = `http://127.0.0.1:${await listen(upstream)}`;
  vite = await createViteServer({
    configFile: false, logLevel: 'silent', cacheDir: 'tmp/lm-studio-proxy-test-cache', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, proxy: { '/lm-studio': { target, changeOrigin: false, rewrite: (path) => path.replace(/^\/lm-studio/, ''), configure: endResponseWhenUpstreamDies } } },
  });
  front = createServer(vite.middlewares);
  const port = await listen(front);
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/lm-studio/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, resolve);
    req.on('error', reject);
    req.end('{"stream":true}');
  });
}

function finished(res: IncomingMessage) {
  return new Promise<{ body: string; complete: boolean }>((resolve) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('error', () => undefined);
    res.on('close', () => resolve({ body, complete: res.complete }));
  });
}

const eventStream = { 'content-type': 'text/event-stream' };
const writeThen = (end: (res: ServerResponse) => void) => (res: ServerResponse) => {
  res.writeHead(200, eventStream);
  res.write('data: one\n\n', () => setTimeout(() => end(res), 30));
};

afterEach(async () => {
  await close(front);
  await vite?.close();
  await close(upstream);
  front = upstream = vite = undefined;
});

describe('the /lm-studio dev proxy', () => {
  it.each<[string, (res: ServerResponse) => void]>([
    ['destroyed', (res) => res.destroy()],
    ['reset', (res) => (res.socket as unknown as { resetAndDestroy(): void }).resetAndDestroy()],
  ])('cuts the proxied response when the upstream socket is %s mid-answer', async (_label, end) => {
    const result = await finished(await proxied(writeThen(end)));
    expect(result).toEqual({ body: 'data: one\n\n', complete: false });
  }, 5_000);

  it('leaves a response that ends normally complete', async () => {
    const result = await finished(await proxied(writeThen((res) => res.end('data: [DONE]\n\n'))));
    expect(result).toEqual({ body: 'data: one\n\ndata: [DONE]\n\n', complete: true });
  });

  it('leaves a non-stream answer as it is', async () => {
    const res = await proxied((upstreamRes) => {
      upstreamRes.writeHead(503, { 'content-type': 'application/json' });
      upstreamRes.end('{"error":"busy"}');
    });
    expect(res.statusCode).toBe(503);
    expect(await finished(res)).toEqual({ body: '{"error":"busy"}', complete: true });
  });

  it('is what the dev server config uses for that route', () => {
    expect(readFileSync('vite.config.ts', 'utf8')).toMatch(/'\/lm-studio': \{[^}]*configure: endResponseWhenUpstreamDies,/);
  });
});
