import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLiveAudio, PcmPreviewBuffer } from './live-audio';
afterEach(() => vi.unstubAllGlobals());

describe('bounded PCM previews', () => {
  it('requests a supported rate and lets durable recording continue when Web Audio fails', async () => {
    const construct = vi.fn(function (options: AudioContextOptions) {
      expect(options.sampleRate).toBe(48000);
      throw new Error('Audio output unavailable');
    });
    vi.stubGlobal('AudioContext', construct);
    vi.stubGlobal('AudioWorkletNode', vi.fn());
    await expect(captureLiveAudio({} as MediaStream)).resolves.toBeNull();
    expect(construct).toHaveBeenCalledOnce();
  });
  it('produces independently decodable WAV windows with absolute offsets', async () => {
    const buffer = new PcmPreviewBuffer(8, 60);
    buffer.append(new Float32Array(8 * 40).fill(0.25));
    const first = buffer.read(0)!;
    expect(first.start).toBe(0);
    expect(first.end).toBe(24);
    expect(first.audio.type).toBe('audio/wav');
    expect(first.audio.size).toBe(44 + 24 * 8 * 2);
    const header = await first.audio.arrayBuffer();
    expect(new TextDecoder().decode(header.slice(0, 4))).toBe('RIFF');
    expect(new DataView(header).getUint32(24, true)).toBe(8);
    const second = buffer.read(22)!;
    expect(second.start).toBe(22);
    expect(second.end).toBe(40);
  });

  it('bounds memory for long recordings and reports when the caller has fallen behind', () => {
    const buffer = new PcmPreviewBuffer(10, 60);
    for (let i = 0; i < 1000; i++) buffer.append(new Float32Array(10));
    expect(buffer.retainedSamples).toBe(600);
    expect(buffer.read(0)).toMatchObject({ start: 940, end: 964 });
    expect(buffer.read(1000)).toBeNull();
  });
});
