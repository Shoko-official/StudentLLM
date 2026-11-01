import { describe, expect, it, vi } from 'vitest';
import { NimDocumentEngine, NIM_VISION_MODEL } from './nim-document-engine';
import type { DocumentPageImage } from './nim-document-engine';

const imageData = 'data:image/png;base64,iVBORw0KGgo=';
const document = new Blob(['synthetic'], { type: 'image/png' });
async function* pages(): AsyncIterable<DocumentPageImage> {
  yield { pageNumber: 1, totalPages: 2, imageData };
  yield { pageNumber: 2, totalPages: 2, imageData };
}
const response = (content = '# Title\n\nSources → Notes', finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }));
const options = () => ({ consent: true as const, renderPages: pages, requestSpacingMs: 0 });

describe('explicit NVIDIA document analysis', () => {
  it('sends rendered images only to the fixed same-origin proxy and preserves page order and Markdown', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const onProgress = vi.fn();
    const result = await new NimDocumentEngine({ ...options(), fetchImpl, onProgress }).extract(document);
    expect(result.model).toBe(NIM_VISION_MODEL);
    expect(result.pages.map(p => p.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0]).toMatchObject({ text: '# Title\n\nSources → Notes', blocks: [{ kind: 'markdown', text: '# Title\n\nSources → Notes' }] });
    expect(onProgress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('/nvidia-nim/v1/chat/completions');
    expect(request?.redirect).toBe('error');
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({ model: NIM_VISION_MODEL, stream: false, max_tokens: 8192, chat_template_kwargs: { enable_thinking: false } });
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: imageData } });
    expect(request?.headers).not.toHaveProperty('authorization');
  });

  it('does not render or fetch without explicit per-file consent', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const renderPages = vi.fn(pages);
    await expect(new NimDocumentEngine({ ...options(), consent: false as never, fetchImpl, renderPages }).extract(document)).rejects.toThrow(/confirm|consent/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(renderPages).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 404, 504, 202])('rejects HTTP %s without echoing an arbitrary upstream response or switching models', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'secret-value-do-not-echo' }), { status }));
    const failure = await new NimDocumentEngine({ ...options(), fetchImpl }).extract(document).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).not.toContain('secret-value');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([['<think>reasoning only', 'stop'], ['', 'stop'], ['unfinished transcription', 'length'], ['filtered partial text', 'content_filter'], ['partial tool output', 'tool_calls']])('rejects incomplete final output', async (text, finish) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(text, finish));
    await expect(new NimDocumentEngine({ ...options(), fetchImpl }).extract(document)).rejects.toThrow(/final|incomplete|truncated/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never fetches if already cancelled and aborts a body that ignores its signal within the total budget', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(new NimDocumentEngine({ ...options(), fetchImpl, signal: AbortSignal.abort() }).extract(document)).rejects.toThrow(/cancel/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: new ReadableStream({ start() {} }) } as Response);
    await expect(new NimDocumentEngine({ ...options(), fetchImpl, timeoutMs: 20 }).extract(document)).rejects.toThrow(/time/i);
  });

  it('rejects non-data image URLs before any upstream request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    async function* remotePage() { yield { pageNumber: 1, totalPages: 1, imageData: 'https://example.com/private.png' }; }
    await expect(new NimDocumentEngine({ ...options(), fetchImpl, renderPages: remotePage }).extract(document)).rejects.toThrow(/image/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
