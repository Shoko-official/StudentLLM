import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPendingRecordings, RECORDING_RECOVERY_STORAGE_KEY, removePendingRecording, savePendingRecording } from './recording-recovery';

describe('recording recovery manifest', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips pending recordings and replaces duplicate ids', () => {
    const first = { recordingId: 'recording-1', lessonId: 'lesson-1', lessonTitle: 'First course', startedAt: 100 };
    const replacement = { ...first, lessonTitle: 'Renamed course', startedAt: 200 };

    expect(savePendingRecording(first)).toBe(true);
    expect(savePendingRecording(replacement)).toBe(true);
    expect(listPendingRecordings()).toEqual([replacement]);
  });

  it('drops malformed manifest entries and removes completed recordings', () => {
    localStorage.setItem('studentllm.recording-recovery.v1', JSON.stringify({
      version: 1,
      recordings: [
        { recordingId: 'valid', lessonId: 'lesson-1', lessonTitle: 'Course', startedAt: 100 },
        { recordingId: 'invalid', lessonId: 'lesson-1', lessonTitle: 'Course', startedAt: 'now' },
      ],
    }));

    expect(listPendingRecordings()).toHaveLength(1);
    expect(removePendingRecording('valid')).toBe(true);
    expect(listPendingRecordings()).toEqual([]);
  });
});

describe('a full localStorage', () => {
  const entry = { recordingId: 'rec-full', lessonId: 'lesson-1', lessonTitle: 'Course', startedAt: 1 };
  const refuseLocalStorage = () => {
    const realSet = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    });
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('still accepts the manifest of a recording, keeping it for the browsing session', () => {
    refuseLocalStorage();
    expect(savePendingRecording(entry)).toBe(true);
    expect(listPendingRecordings()).toEqual([entry]);
    expect(localStorage.getItem(RECORDING_RECOVERY_STORAGE_KEY)).toBeNull();

    expect(removePendingRecording(entry.recordingId)).toBe(true);
    expect(listPendingRecordings()).toEqual([]);
  });

  it('merges the two places when listing, without duplicates', () => {
    expect(savePendingRecording(entry)).toBe(true);
    const spy = refuseLocalStorage();
    expect(savePendingRecording({ ...entry, recordingId: 'rec-second' })).toBe(true);
    spy.mockRestore();
    // The same recording is also in the session copy: it is listed once.
    sessionStorage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, recordings: [{ ...entry, recordingId: 'rec-second' }, entry] }));
    expect(listPendingRecordings().map((item) => item.recordingId).sort()).toEqual(['rec-full', 'rec-second']);
  });

  it('refuses when the storage given explicitly refuses, as before', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => undefined } as unknown as Storage;
    expect(savePendingRecording(entry, storage)).toBe(false);
  });
});
