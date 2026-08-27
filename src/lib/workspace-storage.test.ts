import { beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspace, saveWorkspace, WorkspaceSnapshot } from './workspace-storage';

const fallback: WorkspaceSnapshot = {
  activeLessonId: 'fallback',
  lessons: [{
    id: 'fallback',
    subject: 'Mathematics',
    chapter: 'Algebra',
    title: 'Initial course',
    teacher: 'Professor',
    duration: '00:10:00',
    date: 'today',
    progress: 0,
  }],
  transcript: [],
  artifacts: [],
};

describe('workspace storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a workspace snapshot through local storage', () => {
    const snapshot: WorkspaceSnapshot = {
      ...fallback,
      activeLessonId: 'new-lesson',
      lessons: [{ ...fallback.lessons[0], id: 'new-lesson', title: 'Persistent course' }],
      artifacts: [{ id: 'artifact-1', kind: 'summary', label: 'Summary', createdAt: 'just now' }],
    };

    expect(saveWorkspace(snapshot)).toBe(true);
    expect(loadWorkspace(fallback)).toEqual(snapshot);
  });

  it('falls back safely when stored data is malformed', () => {
    localStorage.setItem('studentllm.workspace.v1', '{not-json');

    expect(loadWorkspace(fallback)).toEqual(fallback);
  });

  it('drops invalid child records instead of restoring corrupt state', () => {
    localStorage.setItem('studentllm.workspace.v1', JSON.stringify({
      version: 1,
      activeLessonId: 'valid',
      lessons: [{ ...fallback.lessons[0], id: 'valid' }, { id: 42 }],
      transcript: [{ id: 'ok', timestamp: '00:01', speaker: 'Professor', text: 'Text' }, { id: 7 }],
      artifacts: [{ id: 'ok', kind: 'summary', label: 'Summary', createdAt: 'now' }, { id: 'bad', kind: 'unknown' }],
    }));

    const loaded = loadWorkspace(fallback);
    expect(loaded.lessons).toHaveLength(1);
    expect(loaded.transcript).toHaveLength(1);
    expect(loaded.artifacts).toHaveLength(1);
  });
});
