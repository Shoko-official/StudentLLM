import { describe, expect, it, vi } from 'vitest';
import { LocalSpeechEngine, createLocalSpeechEngine } from './speech-engine';

describe('local speech engine', () => {
  it('posts audio and normalizes returned segments', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'faster-whisper-small',
      language: 'fr',
      segments: [{ start: 1.9, text: 'Bonjour le monde', speaker: 'Professor' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const engine = new LocalSpeechEngine({ baseUrl: 'http://127.0.0.1:8765/', fetchImpl });
    const audio = new Blob(['audio'], { type: 'audio/webm' });

    await expect(engine.transcribe(audio)).resolves.toEqual({
      model: 'faster-whisper-small',
      language: 'fr',
      segments: [{
        id: 'local-asr-0',
        timestamp: '00:00:01',
        speaker: 'Professor',
        text: 'Bonjour le monde',
        status: 'review',
      }],
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8765/transcribe', expect.objectContaining({
      method: 'POST',
      body: audio,
      headers: { 'content-type': 'audio/webm' },
    }));
  });

  it('reports an HTTP failure from the local service', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid audio.' }), { status: 422 }));
    const engine = new LocalSpeechEngine({ baseUrl: 'http://127.0.0.1:8765', fetchImpl });

    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('Local transcription failed (422): Invalid audio.');
  });

  it('binds the default fetch implementation to its global context', async () => {
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error('fetch context was lost');
      return Promise.resolve(new Response(JSON.stringify({
        model: 'faster-whisper-small',
        segments: [{ start: 0, text: 'Bound fetch works.' }],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const engine = new LocalSpeechEngine({ baseUrl: 'http://127.0.0.1:8765', timeoutMs: 1_000 });

      await expect(engine.transcribe(new Blob(['audio']))).resolves.toMatchObject({
        model: 'faster-whisper-small',
        segments: [{ text: 'Bound fetch works.' }],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is disabled until a local endpoint is configured', () => {
    expect(createLocalSpeechEngine({})).toBeNull();
    expect(createLocalSpeechEngine({ VITE_LOCAL_ASR_BASE_URL: 'http://127.0.0.1:8765', VITE_LOCAL_ASR_LANGUAGE: 'fr' })).toBeInstanceOf(LocalSpeechEngine);
  });
});
