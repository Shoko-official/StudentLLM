import { beforeEach, describe, expect, it } from 'vitest';
import { listPendingRecordings, removePendingRecording, savePendingRecording } from './recording-recovery';

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
