import { describe, expect, it } from 'vitest';
import { LocalDocumentEngine } from './document-engine';

describe('document response limits', () => {
  it('rejects an oversized document before sending it to the sidecar', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });
    const document = new Blob(['pdf'], { type: 'application/pdf' });
    Object.defineProperty(document, 'size', { value: 100 * 1024 * 1024 + 1 });
    const engine = new LocalDocumentEngine({ baseUrl: 'http://127.0.0.1:8766', fetchImpl });

    await expect(engine.extract(document)).rejects.toThrow('document is too large');
  });

  it('rejects an unexpectedly large extraction response', async () => {
    const text = 'x'.repeat(8 * 1024 * 1024 + 1);
    const engine = new LocalDocumentEngine({
      baseUrl: 'http://127.0.0.1:8766',
      fetchImpl: async () => new Response(JSON.stringify({ model: 'test', pages: [{ pageNumber: 1, text, blocks: [] }] }), { status: 200 }),
    });

    await expect(engine.extract(new Blob(['pdf'], { type: 'application/pdf' }))).rejects.toThrow('response is too large');
  });
});
