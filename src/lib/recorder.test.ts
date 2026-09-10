import { afterEach, describe, expect, it, vi } from 'vitest';
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
    list: vi.fn(async (recordingId: string) => chunks.filter((chunk) => chunk.recordingId === recordingId)),
    count: vi.fn(async (recordingId: string) => chunks.filter((chunk) => chunk.recordingId === recordingId).length),
    clear: vi.fn(async () => undefined),
  };
}

describe('recorder sessions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects when supplied microphone APIs are missing', async () => {
    const mediaRecorderFactory = vi.fn();

    await expect(requestRecorderSession({
      mediaDevices: {} as Pick<MediaDevices, 'getUserMedia'>,
      mediaRecorderFactory,
      recordingId: 'recording-unavailable',
    })).rejects.toThrow('Microphone access is unavailable in this browser. Use HTTPS or localhost and a browser that supports audio recording.');

    expect(mediaRecorderFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['navigator is missing', undefined],
    ['mediaDevices is missing', {}],
    ['getUserMedia is missing', { mediaDevices: {} }],
    ['getUserMedia is not callable', { mediaDevices: { getUserMedia: true } }],
  ])('rejects when %s', async (_description, browserNavigator) => {
    vi.stubGlobal('navigator', browserNavigator);

    await expect(requestRecorderSession()).rejects.toThrow('Microphone access is unavailable in this browser.');
  });

  it('stops acquired tracks when the browser MediaRecorder API is missing', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;

    await expect(requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    })).rejects.toThrow('MediaRecorder is unavailable in this browser.');

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops acquired tracks when MediaRecorder is unavailable', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;

    await expect(requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      mediaRecorderFactory: () => undefined,
    })).rejects.toThrow('MediaRecorder is unavailable in this browser.');

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops acquired tracks when recorder construction fails', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const constructionError = new Error('Unsupported audio format.');

    await expect(requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      mediaRecorderFactory: () => { throw constructionError; },
    })).rejects.toThrow('Unsupported audio format.');

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops every acquired track and preserves the error when recording fails to start', async () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    const recorder = new FakeMediaRecorder();
    const startError = new DOMException('The audio stream cannot be recorded.', 'NotSupportedError');
    recorder.start.mockImplementation(() => { throw startError; });
    const chunkStore = createStore([]);

    await expect(requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      mediaRecorderFactory: () => recorder,
      chunkStore,
    })).rejects.toBe(startError);

    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(chunkStore.append).not.toHaveBeenCalled();
    expect(recorder.stop).not.toHaveBeenCalled();
  });

  it('propagates microphone permission failures to the caller', async () => {
    const permissionError = new Error('Permission denied.');
    const mediaRecorderFactory = vi.fn();

    await expect(requestRecorderSession({
      mediaDevices: { getUserMedia: vi.fn(async () => { throw permissionError; }) },
      mediaRecorderFactory,
    })).rejects.toBe(permissionError);

    expect(mediaRecorderFactory).not.toHaveBeenCalled();
  });

  it.each([true, false])('uses the browser recorder and persists its final chunk when Opus support is %s', async (supportsOpus) => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const recorder = new FakeMediaRecorder();
    const browserRecorder = Object.assign(vi.fn(function (_stream: MediaStream, _options?: MediaRecorderOptions) {
      return recorder;
    }), { isTypeSupported: vi.fn(() => supportsOpus) });
    vi.stubGlobal('MediaRecorder', browserRecorder);
    const chunks: AudioChunkRecord[] = [];
    const finalChunk = new Blob(['final audio'], { type: supportsOpus ? 'audio/webm;codecs=opus' : 'audio/mp4' });
    recorder.stop.mockImplementation(() => {
      recorder.emit(finalChunk);
      recorder.onstop?.(new Event('stop'));
    });

    const session = await requestRecorderSession({
      chunkStore: createStore(chunks),
      recordingId: 'browser-recording',
    });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(browserRecorder.isTypeSupported).toHaveBeenCalledWith('audio/webm;codecs=opus');
    if (supportsOpus) {
      expect(browserRecorder).toHaveBeenCalledWith(stream, { mimeType: 'audio/webm;codecs=opus' });
    } else {
      expect(browserRecorder).toHaveBeenCalledWith(stream);
    }
    expect(recorder.start).toHaveBeenCalledWith(1000);
    expect(session.stream).toBe(stream);
    expect(session.durability).toBe('durable');
    expect(track.stop).not.toHaveBeenCalled();

    await expect(session.stop()).resolves.toEqual({
      recordingId: 'browser-recording', chunksPersisted: 1, persistenceError: false,
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].blob).toBe(finalChunk);
    await expect(session.readChunks()).resolves.toEqual(chunks);
  });

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
    await expect(session.readChunks()).resolves.toEqual(chunks);
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
