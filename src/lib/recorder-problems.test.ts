import { describe, expect, it, vi } from 'vitest';
import type { AudioChunkRecord, AudioChunkStore } from './recording-storage';
import { describeMicrophoneError, requestRecorderSession, type MediaRecorderLike, type RecorderProblem } from './recorder';

// Like a real MediaRecorder: the browser ends it by itself when the microphone goes away, and asking a recorder that
// has already ended to stop does not produce a second stop event.
class SelfEndingRecorder implements MediaRecorderLike {
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  state: 'recording' | 'inactive' = 'recording';
  readonly start = vi.fn();
  readonly stop = vi.fn(() => {
    if (this.state === 'inactive') return;
    this.end();
  });

  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }

  end() {
    this.state = 'inactive';
    this.onstop?.(new Event('stop'));
  }
}

function createStore(chunks: AudioChunkRecord[], append?: AudioChunkStore['append']): AudioChunkStore {
  return {
    durability: 'durable',
    append: append ?? (async (chunk: AudioChunkRecord) => { chunks.push(chunk); }),
    list: async (recordingId: string) => chunks.filter((chunk) => chunk.recordingId === recordingId),
    count: async (recordingId: string) => chunks.filter((chunk) => chunk.recordingId === recordingId).length,
    clear: async () => undefined,
  };
}

async function session(recorder: MediaRecorderLike, store: AudioChunkStore) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const created = await requestRecorderSession({
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    mediaRecorderFactory: () => recorder,
    chunkStore: store,
    recordingId: 'recording-problems',
  });
  return { created, track };
}

describe('recorder problems', () => {
  it('finishes cleanly when the microphone disappeared before Stop was pressed', async () => {
    const recorder = new SelfEndingRecorder();
    const chunks: AudioChunkRecord[] = [];
    const { created, track } = await session(recorder, createStore(chunks));
    const problems: RecorderProblem[] = [];
    created.onProblem?.((problem) => problems.push(problem));

    recorder.emit(new Blob(['captured before the cable was pulled']));
    recorder.end();
    expect(problems).toEqual(['interrupted']);

    // This used to wait for a stop event that never comes again: the interface stayed on "Saving recording" forever.
    const summary = await created.stop();
    expect(summary).toEqual({ recordingId: 'recording-problems', chunksPersisted: 1, persistenceError: false });
    expect(track.stop).toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
  });

  it('does not report an interruption for a normal stop', async () => {
    const recorder = new SelfEndingRecorder();
    const { created } = await session(recorder, createStore([]));
    const listener = vi.fn();
    created.onProblem?.(listener);

    await created.stop();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops waiting when a recorder never answers the stop request', async () => {
    vi.useFakeTimers();
    try {
      const recorder = new SelfEndingRecorder();
      recorder.stop.mockImplementation(() => undefined);
      const { created } = await session(recorder, createStore([]));

      const stopping = created.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(stopping).resolves.toMatchObject({ recordingId: 'recording-problems', chunksPersisted: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns as soon as a chunk cannot be saved, once, while recording continues', async () => {
    const recorder = new SelfEndingRecorder();
    const append = vi.fn(async () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); });
    const { created } = await session(recorder, createStore([], append));
    const problems: RecorderProblem[] = [];
    created.onProblem?.((problem) => problems.push(problem));

    recorder.emit(new Blob(['one']));
    recorder.emit(new Blob(['two']));
    const summary = await created.stop();

    expect(problems).toEqual(['storage']);
    expect(summary.persistenceError).toBe(true);
  });
});

describe('microphone error messages', () => {
  it.each([
    ['NotAllowedError', /blocked/],
    ['NotFoundError', /No microphone was found/],
    ['NotReadableError', /Another app/],
  ])('explains %s', (name, expected) => {
    expect(describeMicrophoneError(new DOMException('raw browser text', name))).toMatch(expected);
  });

  it('leaves unknown errors to the caller', () => {
    expect(describeMicrophoneError(new Error('Something unexpected'))).toBeNull();
    expect(describeMicrophoneError('text')).toBeNull();
  });
});
