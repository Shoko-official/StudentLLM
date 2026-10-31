import { AudioChunkRecord, AudioChunkStore, createRecordingChunkStore, RecordingDurability } from './recording-storage';
import { captureLiveAudio, type AudioPreviewWindow } from './live-audio';

export interface RecorderStopSummary {
  recordingId: string;
  chunksPersisted: number;
  persistenceError: boolean;
}

/** `interrupted`: the browser stopped recording by itself (microphone unplugged or permission withdrawn). `storage`: a chunk could not be saved. */
export type RecorderProblem = 'interrupted' | 'storage';

export interface RecorderSession {
  /** Called when something goes wrong while recording is still on; what was captured so far is kept. */
  onProblem?: (listener: (problem: RecorderProblem) => void) => void;
  stop: () => Promise<RecorderStopSummary>;
  readChunks: () => Promise<AudioChunkRecord[]>;
  readPreviewWindow?: (fromSeconds: number) => AudioPreviewWindow | null;
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
  mediaRecorderFactory?: (stream: MediaStream, mimeType?: string) => MediaRecorderLike | undefined;
  chunkStore?: AudioChunkStore;
  chunkIntervalMs?: number;
  recordingId?: string;
  now?: () => number;
}

const STOP_TIMEOUT_MS = 5_000;

/** A sentence for a refused or missing microphone, or null when the error is not a known microphone failure. */
export function describeMicrophoneError(error: unknown): string | null {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(name)) {
    return 'Microphone access is blocked. Allow the microphone for StudentLLM in your browser (or in your system privacy settings for the desktop app), then try again.';
  }
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name)) {
    return 'No microphone was found. Plug one in or pick an input device in your system sound settings, then try again.';
  }
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) {
    return 'The microphone could not be opened. Another app may be using it: close that app and try again.';
  }
  return null;
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
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Microphone access is unavailable in this browser. Use HTTPS or localhost and a browser that supports audio recording.');
  }

  const stream = await mediaDevices.getUserMedia({ audio: true });
  const mediaRecorderFactory = options.mediaRecorderFactory ?? browserMediaRecorderFactory();
  if (!mediaRecorderFactory) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('MediaRecorder is unavailable in this browser.');
  }

  const chunkStore = options.chunkStore ?? createRecordingChunkStore();
  const now = options.now ?? Date.now;
  let recorder: MediaRecorderLike | undefined;
  try {
    recorder = mediaRecorderFactory(stream, preferredMimeType());
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  if (!recorder) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('MediaRecorder is unavailable in this browser.');
  }
  let sequence = 0;
  let chunksPersisted = 0;
  let persistenceError = false;
  let pendingWrites = Promise.resolve();
  let stopPromise: Promise<RecorderStopSummary> | undefined;
  const preview = await captureLiveAudio(stream);
  // The browser ends a MediaRecorder by itself when every track ends (device unplugged, permission withdrawn).
  // Remember it, because asking an already finished recorder to stop never produces another stop event.
  let stopRequested = false;
  let recorderEnded = false;
  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => { markEnded = resolve; });
  const problemListeners = new Set<(problem: RecorderProblem) => void>();
  const reportProblem = (problem: RecorderProblem) => problemListeners.forEach((listener) => listener(problem));
  recorder.onstop = () => {
    recorderEnded = true;
    markEnded();
    if (!stopRequested) reportProblem('interrupted');
  };

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
        if (!persistenceError) reportProblem('storage');
        persistenceError = true;
      }
    });
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopRequested = true;
      try {
        if (!recorderEnded) {
          try {
            recorder.stop();
          } catch {
            // Already inactive: the final data was delivered when it ended.
            recorderEnded = true;
          }
          if (!recorderEnded) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_TIMEOUT_MS); })]);
            clearTimeout(timer);
          }
        }
      } finally {
        preview?.close();
        stream.getTracks().forEach((track) => track.stop());
      }
      await pendingWrites;
      return { recordingId, chunksPersisted, persistenceError };
    })();
    return stopPromise;
  };

  try {
    recorder.start(options.chunkIntervalMs ?? 1000);
  } catch (error) {
    preview?.close();
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  return {
    stream,
    stop,
    readChunks: () => chunkStore.list(recordingId),
    onProblem: (listener) => { problemListeners.add(listener); },
    ...(preview ? { readPreviewWindow: preview.read } : {}),
    recordingId,
    durability: chunkStore.durability,
  };
}
