import { AudioChunkStore, createRecordingChunkStore, RecordingDurability } from './recording-storage';

export interface RecorderStopSummary {
  recordingId: string;
  chunksPersisted: number;
  persistenceError: boolean;
}

export interface RecorderSession {
  stop: () => Promise<RecorderStopSummary>;
  stream: MediaStream | null;
  recordingId: string;
  durability: RecordingDurability | 'unavailable';
}

export interface MediaRecorderLike {
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  start: (timeslice?: number) => void;
  stop: () => void;
}

export interface RecorderOptions {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  mediaRecorderFactory?: (stream: MediaStream, mimeType?: string) => MediaRecorderLike;
  chunkStore?: AudioChunkStore;
  chunkIntervalMs?: number;
  recordingId?: string;
  now?: () => number;
}

function createRecordingId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `recording-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function browserMediaRecorderFactory() {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return (stream: MediaStream, mimeType?: string): MediaRecorderLike => (
    mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
  );
}

function preferredMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  const candidate = 'audio/webm;codecs=opus';
  return MediaRecorder.isTypeSupported(candidate) ? candidate : undefined;
}

export async function requestRecorderSession(options: RecorderOptions = {}): Promise<RecorderSession> {
  const mediaDevices = options.mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  const recordingId = options.recordingId ?? createRecordingId();
  if (!mediaDevices?.getUserMedia) {
    return {
      stop: async () => ({ recordingId, chunksPersisted: 0, persistenceError: false }),
      stream: null,
      recordingId,
      durability: 'unavailable',
    };
  }

  const stream = await mediaDevices.getUserMedia({ audio: true });
  const mediaRecorderFactory = options.mediaRecorderFactory ?? browserMediaRecorderFactory();
  if (!mediaRecorderFactory) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('MediaRecorder is unavailable in this browser.');
  }

  const chunkStore = options.chunkStore ?? createRecordingChunkStore();
  const now = options.now ?? Date.now;
  const recorder = mediaRecorderFactory(stream, preferredMimeType());
  let sequence = 0;
  let chunksPersisted = 0;
  let persistenceError = false;
  let pendingWrites = Promise.resolve();
  let stopPromise: Promise<RecorderStopSummary> | undefined;

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    const chunk = {
      recordingId,
      sequence: sequence++,
      blob: event.data,
      recordedAt: now(),
    };
    pendingWrites = pendingWrites.then(async () => {
      try {
        await chunkStore.append(chunk);
        chunksPersisted += 1;
      } catch {
        persistenceError = true;
      }
    });
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      try {
        recorder.stop();
        await stopped;
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
      await pendingWrites;
      return { recordingId, chunksPersisted, persistenceError };
    })();
    return stopPromise;
  };

  recorder.start(options.chunkIntervalMs ?? 1000);
  return {
    stream,
    stop,
    recordingId,
    durability: chunkStore.durability,
  };
}
