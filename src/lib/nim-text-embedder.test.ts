import { describe, expect, it, vi } from 'vitest';
import { NimTextEmbedder } from './nim-text-embedder';

function response(indexes: number[]) {
  return new Response(JSON.stringify({ data: indexes.map(index => ({ index, embedding: Array.from({ length: 512 }, (_, column) => column === index ? 2 : 0) })) }));
}

describe('NIM text retrieval embeddings', () => {
  it('uses distinct passage/query modes, text only and no browser credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => response(JSON.parse(init?.body as string).input.map((_: string, index: number) => index)));
    const embedder = new NimTextEmbedder({ fetchImpl, minIntervalMs: 0 });
    expect((await embedder.embedDocuments(['Un liquide incompressible.']))[0][0]).toBe(1);
    expect((await embedder.embedQuery('Un fluide qui garde sa densité ?'))[0]).toBe(1);
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(bodies.map(body => body.input_type)).toEqual(['passage', 'query']);
    expect(bodies[0]).toMatchObject({ model: 'nvidia/nemotron-3.5-embed-1b', modality: 'text', dimensions: 512, truncate: 'NONE', encoding_format: 'float', embedding_type: 'float' });
    expect(fetchImpl.mock.calls[0][0]).toBe('/nvidia-nim/v1/embeddings');
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });

  it('restores input order from response indexes and rejects incomplete or zero vectors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([1, 0])).mockResolvedValueOnce(response([0])).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(512).fill(0) }] })));
    const embedder = new NimTextEmbedder({ fetchImpl, minIntervalMs: 0 });
    const vectors = await embedder.embedDocuments(['A', 'B']);
    expect(vectors[0][0]).toBe(1); expect(vectors[1][1]).toBe(1);
    await expect(embedder.embedDocuments(['A', 'B'])).rejects.toThrow(/invalid/i);
    await expect(embedder.embedQuery('A')).rejects.toThrow(/invalid/i);
  });

  it('does not retry a quota error or echo upstream details', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private upstream details', { status: 429 }));
    await expect(new NimTextEmbedder({ fetchImpl, minIntervalMs: 0 }).embedQuery('A')).rejects.toThrow('NVIDIA text embeddings unavailable (429).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses images and oversized batches before transmitting anything', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const embedder = new NimTextEmbedder({ fetchImpl, minIntervalMs: 0 });
    await expect(embedder.embedDocuments(['data:image/png;base64,abc'])).rejects.toThrow(/text only/i);
    await expect(embedder.embedDocuments(['<img src="https://example.org/a.png">'])).rejects.toThrow(/text only/i);
    await expect(embedder.embedDocuments(Array(33).fill('text'))).rejects.toThrow(/32/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('spaces requests and cancels a queued request before sending it', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response([0]));
      const embedder = new NimTextEmbedder({ fetchImpl });
      await embedder.embedQuery('first');
      const controller = new AbortController();
      const queued = embedder.embedQuery('cancelled', { signal: controller.signal });
      const failure = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
      await Promise.resolve();
      controller.abort();
      await failure;
      const next = embedder.embedQuery('second');
      await vi.advanceTimersByTimeAsync(1699);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('aborts the actual fetch on deadline and on external cancellation without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    const embedder = new NimTextEmbedder({ fetchImpl, minIntervalMs: 0, timeoutMs: 10 });
    await expect(embedder.embedQuery('timeout')).rejects.toThrow(/timed out/);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = embedder.embedQuery('cancel', { signal: controller.signal });
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });
});
