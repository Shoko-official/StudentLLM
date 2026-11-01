import config from './nvidia-nim-models.json';
import { readJsonResponse } from './response-json';
import { hasEmbeddedImages } from './context-text';

export const NIM_TEXT_EMBEDDING_MODEL = config.embeddingModel;

interface EmbedOptions { signal?: AbortSignal }
interface Options { fetchImpl?: typeof fetch; minIntervalMs?: number; timeoutMs?: number }

/** Text only. Corpus and query modes are deliberately separate; vectors stay in the browser. */
export class NimTextEmbedder {
  readonly cacheKey = `nim-text:${NIM_TEXT_EMBEDDING_MODEL}:512`;
  private readonly fetchImpl: typeof fetch;
  private readonly interval: number;
  private readonly timeout: number;
  private queue: Promise<unknown> = Promise.resolve();
  private nextRequest = 0;

  constructor(options: Options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.interval = options.minIntervalMs ?? 1700;
    this.timeout = options.timeoutMs ?? 15_000;
  }

  embed(inputs: string[], options?: EmbedOptions) { return this.embedDocuments(inputs, options); }
  embedDocuments(inputs: string[], options?: EmbedOptions): Promise<number[][]> { return this.request(inputs, 'passage', options); }
  async embedQuery(input: string, options?: EmbedOptions): Promise<number[]> { return (await this.request([input], 'query', options))[0]; }

  private request(inputs: string[], mode: 'passage' | 'query', options: EmbedOptions = {}): Promise<number[][]> {
    if (!inputs.length) return Promise.resolve([]);
    if (inputs.length > 32) return Promise.reject(new Error('Text embedding batches are limited to 32 passages.'));
    if (inputs.some(input => typeof input !== 'string' || !input.trim() || new TextEncoder().encode(input).length > 32_768)) return Promise.reject(new Error('Text embedding input is empty or too large.'));
    if (inputs.some(input => hasEmbeddedImages(input) || /<img\b/i.test(input))) return Promise.reject(new Error('Retrieval embeddings accept text only; image analysis requires its separate consent.'));
    const result = this.queue.then(() => this.run(inputs, mode, options));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(inputs: string[], mode: 'passage' | 'query', { signal }: EmbedOptions): Promise<number[][]> {
    if (signal?.aborted) throw new DOMException('Embedding cancelled.', 'AbortError');
    const wait = Math.max(0, this.nextRequest - Date.now());
    if (wait) await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new DOMException('Embedding cancelled.', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, wait);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    if (signal?.aborted) throw new DOMException('Embedding cancelled.', 'AbortError');
    this.nextRequest = Date.now() + this.interval;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.timeout);
    try {
      const response = await this.fetchImpl('/nvidia-nim/v1/embeddings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: NIM_TEXT_EMBEDDING_MODEL, input: inputs, input_type: mode, modality: 'text', dimensions: 512, encoding_format: 'float', embedding_type: 'float', truncate: 'NONE' }),
      });
      if (!response.ok) throw new Error(`NVIDIA text embeddings unavailable (${response.status}).`);
      const payload = await readJsonResponse(response, 'text embeddings');
      if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) throw new Error('Invalid text embeddings response.');
      const vectors: number[][] = Array(inputs.length);
      for (const item of payload.data) {
        if (!item || typeof item !== 'object') throw new Error('Invalid text embeddings response.');
        const { index, embedding } = item as { index: unknown; embedding: unknown };
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= inputs.length || vectors[index] || !Array.isArray(embedding) || embedding.length !== 512 || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid text embeddings response.');
        const norm = Math.sqrt(embedding.reduce((sum: number, value: number) => sum + value * value, 0));
        if (!Number.isFinite(norm) || norm <= 0) throw new Error('Invalid text embeddings response.');
        vectors[index] = embedding.map(value => value / norm);
      }
      return vectors;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Embedding cancelled.', 'AbortError');
      if (controller.signal.aborted) throw new Error('NVIDIA text embeddings timed out.');
      if (error instanceof Error && /^(?:NVIDIA text embeddings unavailable \(\d+\)\.|Invalid text embeddings response\.)$/.test(error.message)) throw error;
      throw new Error('NVIDIA text embeddings could not be read.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    }
  }
}
