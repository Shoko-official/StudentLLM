import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspace, loadWorkspaceAsync, saveWorkspace, saveWorkspaceAsync, WorkspaceSnapshot } from './workspace-storage';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

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
  resources: [],
  transcript: [],
  chat: [],
  artifacts: [],
};

describe('workspace storage', () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('round-trips a workspace snapshot through local storage', () => {
    const snapshot: WorkspaceSnapshot = {
      ...fallback,
      activeLessonId: 'new-lesson',
      lessons: [{ ...fallback.lessons[0], id: 'new-lesson', title: 'Persistent course' }],
      chat: [{ id: 'message-1', role: 'user', content: 'Question' }],
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
      chat: [{ id: 'ok', role: 'assistant', content: 'Answer', citations: ['Source'] }, { id: 8 }],
      artifacts: [{ id: 'ok', kind: 'summary', label: 'Summary', createdAt: 'now' }, { id: 'bad', kind: 'unknown' }],
    }));

    const loaded = loadWorkspace(fallback);
    expect(loaded.lessons).toHaveLength(1);
    expect(loaded.transcript).toHaveLength(1);
    expect(loaded.chat).toHaveLength(1);
    expect(loaded.artifacts).toHaveLength(1);
  });

  it('round-trips isolated lesson workspaces', () => {
    const snapshot: WorkspaceSnapshot = {
      ...fallback,
      activeLessonId: 'lesson-one',
      lessons: [
        { ...fallback.lessons[0], id: 'lesson-one', title: 'Course one' },
        { ...fallback.lessons[0], id: 'lesson-two', title: 'Course two' },
      ],
      lessonWorkspaces: {
        'lesson-one': { resources: [], transcript: [{ id: 'one', timestamp: '00:01', speaker: 'Professor', text: 'First course' }], chat: [], artifacts: [] },
        'lesson-two': { resources: [], transcript: [{ id: 'two', timestamp: '00:02', speaker: 'Professor', text: 'Second course' }], chat: [], artifacts: [] },
      },
    };

    expect(saveWorkspace(snapshot)).toBe(true);
    expect(loadWorkspace(fallback)).toEqual(snapshot);
  });

  it('round-trips through the native invoke bridge when Tauri is available', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const snapshot = { ...fallback, activeLessonId: 'native-lesson' };
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);

    expect(await loadWorkspaceAsync(fallback)).toEqual(fallback);
    expect(await saveWorkspaceAsync(snapshot)).toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_workspace');
    expect(invoke).toHaveBeenNthCalledWith(2, 'save_workspace', { snapshot: JSON.stringify({ version: 1, ...snapshot }) });
  });

  it('validates a native snapshot before restoring it', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const snapshot = { ...fallback, activeLessonId: 'native-lesson', lessons: [{ ...fallback.lessons[0], id: 'native-lesson' }] };
    invoke.mockResolvedValue(JSON.stringify({ version: 1, ...snapshot }));

    expect(await loadWorkspaceAsync(fallback)).toEqual(snapshot);
  });

  it('reports native load failures before using the local fallback', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const onError = vi.fn();
    invoke.mockRejectedValueOnce(new Error('database is locked'));
    saveWorkspace(fallback);

    expect(await loadWorkspaceAsync({ ...fallback, lessons: [] }, undefined, { onError })).toEqual(fallback);
    expect(onError).toHaveBeenCalledWith({ operation: 'load', message: 'database is locked' });
  });

  it('reports native save failures while preserving the local fallback', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const onError = vi.fn();
    const snapshot = {
      ...fallback,
      activeLessonId: 'native-lesson',
      lessons: [{ ...fallback.lessons[0], id: 'native-lesson' }],
    };
    invoke.mockRejectedValueOnce(new Error('disk full'));

    expect(await saveWorkspaceAsync(snapshot, undefined, { onError })).toBe(true);
    expect(onError).toHaveBeenCalledWith({ operation: 'save', message: 'disk full' });
    expect(loadWorkspace(fallback)).toEqual(snapshot);
  });
});
