export interface PendingRecording {
  recordingId: string;
  lessonId: string;
  lessonTitle: string;
  startedAt: number;
}

export const RECORDING_RECOVERY_STORAGE_KEY = 'studentllm.recording-recovery.v1';

function getStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function isPendingRecording(value: unknown): value is PendingRecording {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.recordingId === 'string'
    && typeof entry.lessonId === 'string'
    && typeof entry.lessonTitle === 'string'
    && typeof entry.startedAt === 'number'
    && Number.isFinite(entry.startedAt);
}

export function listPendingRecordings(storage: Storage | undefined = getStorage()): PendingRecording[] {
  if (!storage) return [];

  try {
    const raw = storage.getItem(RECORDING_RECOVERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const recordings = (parsed as Record<string, unknown>).recordings;
    return Array.isArray(recordings) ? recordings.filter(isPendingRecording) : [];
  } catch {
    return [];
  }
}

export function savePendingRecording(entry: PendingRecording, storage: Storage | undefined = getStorage()): boolean {
  if (!storage) return false;

  try {
    const recordings = [...listPendingRecordings(storage).filter((item) => item.recordingId !== entry.recordingId), entry];
    storage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, recordings }));
    return true;
  } catch {
    return false;
  }
}

export function removePendingRecording(recordingId: string, storage: Storage | undefined = getStorage()): boolean {
  if (!storage) return false;

  try {
    const recordings = listPendingRecordings(storage).filter((entry) => entry.recordingId !== recordingId);
    if (recordings.length) storage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, recordings }));
    else storage.removeItem(RECORDING_RECOVERY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
