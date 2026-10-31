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

// The manifest is what brings an interrupted recording back, so it must be writable even when localStorage is full (the
// browser keeps a copy of the workspace from before the IndexedDB migration there). When localStorage refuses it, the
// manifest goes to sessionStorage, which survives a reload or a crashed tab but not closing the browser.
function getSessionStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readList(storage: Storage | undefined): PendingRecording[] {
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

function writeList(storage: Storage | undefined, recordings: PendingRecording[]): boolean {
  if (!storage) return false;
  try {
    if (recordings.length) storage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, recordings }));
    else storage.removeItem(RECORDING_RECOVERY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function listPendingRecordings(storage?: Storage): PendingRecording[] {
  const primary = readList(storage ?? safeDefault());
  if (storage) return primary;
  const known = new Set(primary.map((entry) => entry.recordingId));
  return [...primary, ...readList(getSessionStorage()).filter((entry) => !known.has(entry.recordingId))];
}

function safeDefault(): Storage | undefined {
  try {
    return getStorage();
  } catch {
    return undefined;
  }
}

export function savePendingRecording(entry: PendingRecording, storage?: Storage): boolean {
  const primary = storage ?? safeDefault();
  if (writeList(primary, [...readList(primary).filter((item) => item.recordingId !== entry.recordingId), entry])) return true;
  if (storage) return false;
  // localStorage refused (full or blocked): keep the manifest for this browsing session instead of refusing the recording.
  const session = getSessionStorage();
  return writeList(session, [...readList(session).filter((item) => item.recordingId !== entry.recordingId), entry]);
}

export function removePendingRecording(recordingId: string, storage?: Storage): boolean {
  const primary = storage ?? safeDefault();
  if (!primary) return false;
  const removedPrimary = writeList(primary, readList(primary).filter((entry) => entry.recordingId !== recordingId));
  if (storage) return removedPrimary;
  const session = getSessionStorage();
  const removedSession = writeList(session, readList(session).filter((entry) => entry.recordingId !== recordingId));
  return removedPrimary && (removedSession || !session);
}
