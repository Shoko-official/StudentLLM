import { describe, expect, it, vi } from 'vitest';
import { AudioChunkRecord, AudioChunkStore } from './recording-storage';
import { MediaRecorderLike, requestRecorderSession } from './recorder';

class FakeMediaRecorder implements MediaRecorderLike {
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.onstop?.(new Event('stop')));

  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }
}

function createStore(chunks: AudioChunkRecord[], append = vi.fn(async (chunk: AudioChunkRecord) => {
  chunks.push(chunk);
})): AudioChunkStore {
  return {
    durability: 'durable',
    append,
    count: vi.fn(async (recordingId: string) => chunks.filter((chunk) => chunk.recordingId === recordingId).length),
    clear: vi.fn(async () => undefined),
  };
}

describe('recorder sessions', () => {
  it('persists non-empty MediaRecorder chunks in order and stops tracks once', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const chunks: AudioChunkRecord[] = [];
    const recorder = new FakeMediaRecorder();

    const session = await requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      mediaRecorderFactory: () => recorder,
      chunkStore: createStore(chunks),
      chunkIntervalMs: 250,
      recordingId: 'recording-1',
      now: () => 123,
    });

    recorder.emit(new Blob(['first'], { type: 'audio/webm' }));
    recorder.emit(new Blob([]));
    recorder.emit(new Blob(['second'], { type: 'audio/webm' }));

    const summary = await session.stop();
    const secondSummary = await session.stop();

    expect(recorder.start).toHaveBeenCalledWith(250);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(chunks.every((chunk) => chunk.recordingId === 'recording-1' && chunk.recordedAt === 123)).toBe(true);
    expect(summary).toEqual({ recordingId: 'recording-1', chunksPersisted: 2, persistenceError: false });
    expect(secondSummary).toEqual(summary);
  });

  it('reports a persistence failure without claiming the chunk was saved', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const recorder = new FakeMediaRecorder();
    const append = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const chunks: AudioChunkRecord[] = [];

    const session = await requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      mediaRecorderFactory: () => recorder,
      chunkStore: createStore(chunks, append),
      recordingId: 'recording-2',
    });

    recorder.emit(new Blob(['audio'], { type: 'audio/webm' }));
    const summary = await session.stop();

    expect(append).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ recordingId: 'recording-2', chunksPersisted: 0, persistenceError: true });
  });
});
