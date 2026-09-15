import { describe, expect, it } from 'vitest';
import { LocalSpeechEngine } from './speech-engine';

describe('speech response limits', () => {
  it('rejects oversized audio before sending it to the sidecar', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });
    const audio = new Blob(['audio'], { type: 'audio/webm' });
    Object.defineProperty(audio, 'size', { value: 250 * 1024 * 1024 + 1 });
    const engine = new LocalSpeechEngine({ baseUrl: 'http://127.0.0.1:8765', fetchImpl });

    await expect(engine.transcribe(audio)).rejects.toThrow('audio is too large');
  });

  it('rejects an unexpectedly large transcription response', async () => {
    const text = 'x'.repeat(8 * 1024 * 1024 + 1);
    const engine = new LocalSpeechEngine({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: async () => new Response(JSON.stringify({ model: 'test', segments: [], text }), { status: 200 }),
    });

    await expect(engine.transcribe(new Blob(['audio'], { type: 'audio/webm' }))).rejects.toThrow('response is too large');
  });
});
