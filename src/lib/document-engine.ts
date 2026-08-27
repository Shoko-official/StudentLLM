export interface DocumentBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

export interface DocumentPage {
  pageNumber: number;
  text: string;
  blocks: DocumentBlock[];
}

export interface DocumentExtraction {
  model: string;
  pages: DocumentPage[];
}

export interface DocumentEngine {
  extract: (document: Blob) => Promise<DocumentExtraction>;
}

export interface LocalDocumentEngineOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function endpointUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/extract`;
}

export class LocalDocumentEngine implements DocumentEngine {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LocalDocumentEngineOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async extract(document: Blob): Promise<DocumentExtraction> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpointUrl(this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': document.type || 'application/pdf' },
        body: document,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof body?.error === 'string' ? body.error : 'The local document engine rejected the file.';
        throw new Error(`Local document extraction failed (${response.status}): ${detail}`);
      }
      const pages = Array.isArray(body?.pages) ? body.pages.flatMap((page: unknown) => {
        if (!page || typeof page !== 'object') return [];
        const value = page as Record<string, unknown>;
        if (typeof value.pageNumber !== 'number' || !Number.isFinite(value.pageNumber) || typeof value.text !== 'string') return [];
        const blocks = Array.isArray(value.blocks) ? value.blocks.flatMap((block: unknown) => {
          if (!block || typeof block !== 'object') return [];
          const item = block as Record<string, unknown>;
          if (![item.x, item.y, item.width, item.height].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) || typeof item.text !== 'string') return [];
          return [{ x: item.x, y: item.y, width: item.width, height: item.height, text: item.text }];
        }) : [];
        return [{ pageNumber: value.pageNumber, text: value.text, blocks }];
      }) : [];
      return { model: typeof body?.model === 'string' ? body.model : 'local-document-engine', pages };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Local document extraction timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createLocalDocumentEngine(env: Record<string, string | undefined> = import.meta.env) {
  const baseUrl = env.VITE_LOCAL_DOCUMENT_BASE_URL?.trim();
  if (!baseUrl) return null;
  return new LocalDocumentEngine({ baseUrl });
}
