import { describe, expect, it, vi } from 'vitest';
import { probeSidecar } from './sidecar-health';

describe('sidecar health probes', () => {
  it('reports an unconfigured sidecar without making a request', async () => {
    const fetchImpl = vi.fn();

    await expect(probeSidecar('', { fetchImpl })).resolves.toEqual({ available: false, detail: 'Not configured.' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports readiness and the advertised model', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', model: 'small' }), { status: 200 }));

    await expect(probeSidecar('http://127.0.0.1:8765/', { fetchImpl })).resolves.toEqual({ available: true, model: 'small', detail: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8765/health', { signal: expect.any(AbortSignal) });
  });

  it('reports HTTP failures and timeouts without throwing', async () => {
    const failedFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Model unavailable.' }), { status: 503 }));
    await expect(probeSidecar('http://127.0.0.1:8765', { fetchImpl: failedFetch })).resolves.toEqual({ available: false, detail: 'Model unavailable.' });

    const timeoutFetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    await expect(probeSidecar('http://127.0.0.1:8765', { fetchImpl: timeoutFetch, timeoutMs: 1 })).resolves.toEqual({ available: false, detail: 'Health check timed out.' });
  });
});
