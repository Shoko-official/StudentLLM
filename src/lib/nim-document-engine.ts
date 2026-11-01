import type { DocumentEngine, DocumentExtraction } from './document-engine';
import { MAX_DOCUMENT_REQUEST_BYTES, MAX_JSON_REQUEST_BYTES, readJsonResponse } from './response-json';
import { DOCUMENT_TRANSCRIPTION_PROMPT } from '../prompts';
export { DOCUMENT_TRANSCRIPTION_PROMPT } from '../prompts';

export const NIM_VISION_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export interface DocumentPageImage { pageNumber: number; totalPages: number; imageData: string }
export interface NimDocumentEngineOptions {
  consent: true;
  fetchImpl?: typeof fetch;
  renderPages?: (document: Blob, signal: AbortSignal) => AsyncIterable<DocumentPageImage>;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  timeoutMs?: number;
  requestSpacingMs?: number;
}

export class NimDocumentEngine implements DocumentEngine {
  constructor(readonly options: NimDocumentEngineOptions) {}
  async extract(document: Blob): Promise<DocumentExtraction> {
    if (this.options.consent !== true) throw new Error('Confirm consent before sending document images to NVIDIA.');
    if (this.options.signal?.aborted) throw new Error('NVIDIA document analysis cancelled.');
    if (document.size > MAX_DOCUMENT_REQUEST_BYTES) throw new Error('The document is too large.');
    const controller = new AbortController();
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const renderPages = this.options.renderPages ?? (async function* (blob: Blob, signal: AbortSignal) {
      const { renderDocumentImages } = await import('./document-images');
      yield* renderDocumentImages(blob, signal);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      const stop = (message: string) => { controller.abort(); reject(new Error(message)); };
      cancel = () => stop('NVIDIA document analysis cancelled.');
      this.options.signal?.addEventListener('abort', cancel, { once: true });
      if (this.options.signal?.aborted) cancel();
      const timeout = Number.isFinite(this.options.timeoutMs) ? Math.max(1, Math.min(this.options.timeoutMs!, 300_000)) : 300_000;
      timer = setTimeout(() => stop('NVIDIA document analysis timed out. The original file is still saved.'), timeout);
    });
    const run = async (): Promise<DocumentExtraction> => {
      const pages: DocumentExtraction['pages'] = [];
      let total = 0;
      let previousRequest = 0;
      for await (const page of renderPages(document, controller.signal)) {
        controller.signal.throwIfAborted();
        if (!Number.isInteger(page.totalPages) || page.totalPages < 1 || page.totalPages > 100
          || page.pageNumber !== pages.length + 1 || (total && total !== page.totalPages)) {
          throw new Error('NVIDIA analysis supports up to 100 pages in their original order. Split larger PDFs or use local extraction.');
        }
        if (!total) { total = page.totalPages; this.options.onProgress?.(0, total); }
        if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(page.imageData)) throw new Error('The page image could not be prepared.');
        const body = JSON.stringify({
          model: NIM_VISION_MODEL,
          messages: [{ role: 'user', content: [
            { type: 'text', text: DOCUMENT_TRANSCRIPTION_PROMPT },
            { type: 'image_url', image_url: { url: page.imageData } },
          ] }],
          max_tokens: 8192, temperature: 0, stream: false,
          chat_template_kwargs: { enable_thinking: false },
        });
        if (new TextEncoder().encode(body).byteLength > MAX_JSON_REQUEST_BYTES) throw new Error('The page image is too large for NVIDIA analysis.');
        // One request at a time, at most 30 page requests/minute; never rotate credentials or retry quota errors.
        const spacing = this.options.requestSpacingMs ?? 2_000;
        if (previousRequest) await waitForNextRequest(Math.max(0, spacing - (Date.now() - previousRequest)), controller.signal);
        controller.signal.throwIfAborted();
        previousRequest = Date.now();
        const response = await fetchImpl('/nvidia-nim/v1/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), redirect: 'error',
        });
        if (response.status !== 200) throw new Error(describeVisionFailure(response));
        const result = await readJsonResponse(response, 'NVIDIA document');
        controller.signal.throwIfAborted();
        const choices = Array.isArray(result.choices) ? result.choices : [];
        const choice = choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } | undefined;
        if (choice?.finish_reason !== 'stop') throw new Error('NVIDIA returned an incomplete transcription. The original file is still saved.');
        const raw = choice?.message?.content;
        const text = typeof raw === 'string' ? raw.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '').trim() : '';
        if (!text) throw new Error('NVIDIA returned no final transcription. The original file is still saved.');
        pages.push({ pageNumber: page.pageNumber, text,
          blocks: [{ x: 0, y: 0, width: 0, height: 0, kind: 'markdown', text }] });
        this.options.onProgress?.(pages.length, total);
      }
      if (!pages.length || pages.length !== total) throw new Error('The document image sequence is incomplete. The original file is still saved.');
      return { model: NIM_VISION_MODEL, pages };
    };
    try {
      return await Promise.race([run(), interrupted]);
    } catch (error) {
      if (this.options.signal?.aborted) throw new Error('NVIDIA document analysis cancelled.');
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error('NVIDIA document analysis timed out. The original file is still saved.');
      // Local preparation errors are ours; upstream transport exceptions can contain request details.
      if (error instanceof TypeError) throw new Error('Could not reach NVIDIA document analysis. The original file is still saved.');
      throw error;
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
}


function describeVisionFailure(response: Response): string {
  if (response.headers.get('x-studentllm-proxy-error') === 'missing_key') return 'The NVIDIA key is not configured on the local server.';
  if (response.status === 401 || response.status === 403) return 'NVIDIA document analysis rejected the connection. Check the server key and provider settings.';
  if (response.status === 429) return 'NVIDIA document analysis reached its request limit. Try again later; the original is still saved.';
  if (response.status === 404 || response.status === 410) return 'The NVIDIA vision model is unavailable. Use local extraction or try again later.';
  if (response.status === 202) return 'NVIDIA has not completed this document analysis. Try again later; the original is still saved.';
  if (response.status === 504) return 'NVIDIA document analysis timed out. The original file is still saved.';
  return `NVIDIA document analysis failed (HTTP ${response.status}). The original file is still saved.`;
}

function waitForNextRequest(ms: number, signal: AbortSignal): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
