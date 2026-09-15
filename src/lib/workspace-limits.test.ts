import { describe, expect, it } from 'vitest';
import { loadWorkspace } from './workspace-storage';

describe('workspace snapshot limits', () => {
  it('falls back before parsing an oversized browser snapshot', () => {
    const fallback = { activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] };
    const raw = JSON.stringify({ version: 1, lessons: [], padding: 'x'.repeat(16 * 1024 * 1024 + 1) });
    const storage = {
      getItem: (key: string) => key === 'studentllm.workspace.v1' ? raw : null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 1,
    } as unknown as Storage;

    expect(loadWorkspace(fallback, storage)).toBe(fallback);
  });
});
