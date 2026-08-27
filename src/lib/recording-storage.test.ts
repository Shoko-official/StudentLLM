import { describe, expect, it } from 'vitest';
import { createRecordingChunkStore } from './recording-storage';

describe('recording chunk storage', () => {
  it('keeps a memory fallback explicit when IndexedDB is unavailable', async () => {
    const store = createRecordingChunkStore(undefined);
    const chunk = {
      recordingId: 'recording-1',
      sequence: 0,
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      recordedAt: 123,
    };

    expect(store.durability).toBe('memory-only');
    await store.append(chunk);
    expect(await store.count('recording-1')).toBe(1);
    await store.clear('recording-1');
    expect(await store.count('recording-1')).toBe(0);
  });
});
