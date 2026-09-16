import type { TranscriptSegment } from '../types';
import { MAX_AUDIO_REQUEST_BYTES, readJsonResponse } from './response-json';
import { normalizeServiceBaseUrl } from './service-url';

export interface SpeechTranscription {
  segments: TranscriptSegment[];
  model: string;
  language?: string;
}

export interface SpeechEngine {
  transcribe: (audio: Blob, options?: { mode?: 'preview'; signal?: AbortSignal }) => Promise<SpeechTranscription>;
}

export interface LocalSpeechEngineOptions {
  baseUrl: string;
  language?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function endpointUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/transcribe`;
}

function timestamp(seconds: unknown) {
  const totalSeconds = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const remainder = (totalSeconds % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${remainder}`;
}

export class LocalSpeechEngine implements SpeechEngine {
  private readonly baseUrl: string;
  private readonly language: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LocalSpeechEngineOptions) {
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
    this.language = options.language;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async transcribe(audio: Blob, options?: { mode?: 'preview'; signal?: AbortSignal }): Promise<SpeechTranscription> {
    if (audio.size > MAX_AUDIO_REQUEST_BYTES) throw new Error('The audio is too large.');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    if (options?.signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const params = new URLSearchParams();
      if (this.language) params.set('language', this.language);
      if (options?.mode) params.set('mode', options.mode);
      const query = params.size ? `?${params}` : '';
      const response = await this.fetchImpl(`${endpointUrl(this.baseUrl)}${query}`, {
        method: 'POST',
        headers: { 'content-type': audio.type || 'application/octet-stream' },
        body: audio,
        signal: controller.signal,
      });
      const body = await readJsonResponse(response, 'speech engine');
      if (!response.ok) {
        const detail = typeof body?.error === 'string' ? body.error : 'The local speech engine rejected the audio.';
        throw new Error(`Local transcription failed (${response.status}): ${detail}`);
      }

      const segments = Array.isArray(body?.segments) ? body.segments.flatMap((segment: unknown, index: number) => {
        if (!segment || typeof segment !== 'object') return [];
        const value = segment as Record<string, unknown>;
        const text = typeof value.text === 'string' ? value.text.trim() : '';
        if (!text) return [];
        return [{
          id: typeof value.id === 'string' ? value.id : `local-asr-${index}`,
          timestamp: timestamp(value.start),
          speaker: typeof value.speaker === 'string' ? value.speaker.trim() : '',
          ...(typeof value.start === 'number' && typeof value.end === 'number' && Number.isFinite(value.start) && Number.isFinite(value.end) && value.end >= value.start
            ? { start: Math.max(0, value.start), end: value.end } : {}),
          ...(Array.isArray(value.words) ? { words: value.words.filter((word): word is { start: number; end: number; word: string } => word && typeof word.word === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start) } : {}),
          text,
          status: 'review' as const,
        }];
      }) : [];
      return {
        segments,
        model: typeof body?.model === 'string' ? body.model : 'local-speech-engine',
        language: typeof body?.language === 'string' ? body.language : undefined,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && !options?.signal?.aborted) throw new Error('Local transcription timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', cancel);
    }
  }
}

export function createLocalSpeechEngine(env: Record<string, string | undefined> = import.meta.env) {
  const baseUrl = env.VITE_LOCAL_ASR_BASE_URL?.trim();
  if (!baseUrl) return null;
  try {
    return new LocalSpeechEngine({
      baseUrl,
      language: env.VITE_LOCAL_ASR_LANGUAGE?.trim() || undefined,
    });
  } catch {
    return null;
  }
}
