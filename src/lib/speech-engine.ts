import type { TranscriptSegment } from '../types';

export interface SpeechTranscription {
  segments: TranscriptSegment[];
  model: string;
  language?: string;
}

export interface SpeechEngine {
  transcribe: (audio: Blob) => Promise<SpeechTranscription>;
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
    this.baseUrl = options.baseUrl;
    this.language = options.language;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async transcribe(audio: Blob): Promise<SpeechTranscription> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const query = this.language ? `?language=${encodeURIComponent(this.language)}` : '';
      const response = await this.fetchImpl(`${endpointUrl(this.baseUrl)}${query}`, {
        method: 'POST',
        headers: { 'content-type': audio.type || 'application/octet-stream' },
        body: audio,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
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
          speaker: typeof value.speaker === 'string' && value.speaker.trim() ? value.speaker : 'Speaker',
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
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Local transcription timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createLocalSpeechEngine(env: Record<string, string | undefined> = import.meta.env) {
  const baseUrl = env.VITE_LOCAL_ASR_BASE_URL?.trim();
  if (!baseUrl) return null;
  return new LocalSpeechEngine({
    baseUrl,
    language: env.VITE_LOCAL_ASR_LANGUAGE?.trim() || undefined,
  });
}
