import { describe, expect, it, vi } from 'vitest';
import { createLocalDocumentEngine, LocalDocumentEngine } from './document-engine';

describe('local document engine', () => {
  it('posts a PDF and normalizes page blocks', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'pymupdf',
      pages: [{
        pageNumber: 1,
        text: 'A page of notes.',
        blocks: [{ x: 1, y: 2, width: 30, height: 12, text: 'A page of notes.' }, { x: 'invalid', text: 'discarded' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const engine = new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766/', fetchImpl });

    await expect(engine.extract(new Blob(['pdf'], { type: 'application/pdf' }))).resolves.toEqual({
      model: 'pymupdf',
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

  it('surfaces sidecar failures', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'PyMuPDF is not installed.' }), { status: 422 }));

    await expect(new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766', fetchImpl }).extract(new Blob(['pdf'])))
      .rejects.toThrow('Local document extraction failed (422): PyMuPDF is not installed.');
  });

  it('only creates the adapter when configured', () => {
    expect(createLocalDocumentEngine({})).toBeNull();
    expect(createLocalDocumentEngine({ VITE_LOCAL_DOCUMENT_BASE_URL: 'http://127.0.0.1:8766' })).toBeInstanceOf(LocalDocumentEngine);
  });
});
