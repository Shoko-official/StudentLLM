import { describe, expect, it, vi } from 'vitest';
import { createLocalDocumentEngine, LocalDocumentEngine } from './document-engine';

describe('local document engine', () => {
  it('posts a PDF and normalizes page blocks', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'pdfminer',
      pages: [{
        pageNumber: 1,
        text: 'A page of notes.',
        blocks: [{ x: 1, y: 2, width: 30, height: 12, text: 'A page of notes.' }, { x: 'invalid', text: 'discarded' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const engine = new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766/', fetchImpl });

    await expect(engine.extract(new Blob(['pdf'], { type: 'application/pdf' }))).resolves.toEqual({
      model: 'pdfminer',
      pages: [{
        pageNumber: 1,
        text: 'A page of notes.',
        blocks: [{ x: 1, y: 2, width: 30, height: 12, text: 'A page of notes.' }],
      }],
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8766/extract', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
    }));
  });

  it('preserves structured block metadata for document parsers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'docx-xml',
      pages: [{
        pageNumber: 1,
        text: 'Title\nA | B',
        blocks: [
          { x: 0, y: 0, width: 0, height: 0, text: 'Title', kind: 'heading' },
          { x: 0, y: 20, width: 0, height: 0, text: 'A | B', kind: 'table', rows: [['A', 'B']] },
        ],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const extraction = await new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766', fetchImpl }).extract(new Blob(['docx'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));

    expect(extraction.pages[0].blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'heading' }),
      expect.objectContaining({ kind: 'table', rows: [['A', 'B']] }),
    ]));
  });

  it('surfaces sidecar failures', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'The PDF engine is not installed.' }), { status: 422 }));

    await expect(new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766', fetchImpl }).extract(new Blob(['pdf'])))
      .rejects.toThrow('Local document extraction failed (422): The PDF engine is not installed.');
  });

  it('binds the default fetch implementation to its global context', async () => {
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error('fetch context was lost');
      return Promise.resolve(new Response(JSON.stringify({
        model: 'pdfminer',
        pages: [{ pageNumber: 1, text: 'Bound fetch works.', blocks: [] }],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const engine = new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766', timeoutMs: 1_000 });

      await expect(engine.extract(new Blob(['pdf']))).resolves.toMatchObject({
        model: 'pdfminer',
        pages: [{ text: 'Bound fetch works.' }],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('only creates the adapter when configured', () => {
    expect(createLocalDocumentEngine({})).toBeNull();
    expect(createLocalDocumentEngine({ VITE_LOCAL_DOCUMENT_BASE_URL: 'http://127.0.0.1:8766' })).toBeInstanceOf(LocalDocumentEngine);
  });
  it('allows large scanned documents more time for OCR', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
      }));
      const engine = new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766', timeoutMs: 1_000, fetchImpl });
      const scan = new Blob([new Uint8Array(20 * 1024 * 1024)], { type: 'application/pdf' });
      const pending = engine.extract(scan);
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20 * 15_000);
      expect(aborted).toBe(true);
      await expect(pending).rejects.toThrow('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
