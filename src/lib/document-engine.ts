import { normalizeExtractedDocumentText } from './document-text';
import { MAX_DOCUMENT_REQUEST_BYTES, readJsonResponse } from './response-json';
import { normalizeServiceBaseUrl } from './service-url';

export interface DocumentBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  kind?: 'text' | 'heading' | 'paragraph' | 'list' | 'code' | 'formula' | 'table' | 'diagram' | 'image';
  rows?: string[][];
  imageData?: string;
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

function isFormulaImageData(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 900_000
    && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export class LocalDocumentEngine implements DocumentEngine {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LocalDocumentEngineOptions) {
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async extract(document: Blob): Promise<DocumentExtraction> {
    if (document.size > MAX_DOCUMENT_REQUEST_BYTES) throw new Error('The document is too large.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpointUrl(this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': document.type || 'application/pdf' },
        body: document,
        signal: controller.signal,
      });
      const body = await readJsonResponse(response, 'document engine');
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
          const x = item.x as number;
          const y = item.y as number;
          const width = item.width as number;
          const height = item.height as number;
          return [{
            x,
            y,
            width,
            height,
            text: item.text,
            ...(typeof item.kind === 'string' && ['text', 'heading', 'paragraph', 'list', 'code', 'formula', 'table', 'diagram', 'image'].includes(item.kind) ? { kind: item.kind as DocumentBlock['kind'] } : {}),
            ...(Array.isArray(item.rows) && item.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string')) ? { rows: item.rows as string[][] } : {}),
            ...(isFormulaImageData(item.imageData) ? { imageData: item.imageData } : {}),
          }];
        }) : [];
        return [{
          pageNumber: value.pageNumber,
          text: normalizeExtractedDocumentText(value.text),
          blocks: blocks.map((block) => ({ ...block, text: normalizeExtractedDocumentText(block.text) })),
        }];
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
