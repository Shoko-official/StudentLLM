import { beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceWithStatus, readWorkspaceCopy, saveWorkspace, WORKSPACE_STORAGE_KEY, WORKSPACE_UNREADABLE_BACKUP_KEY, type WorkspaceSnapshot } from './workspace-storage';

const empty: WorkspaceSnapshot = { activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] };

describe('unreadable stored workspaces', () => {
  beforeEach(() => localStorage.clear());

  it('reports no issue on a first launch', () => {
    expect(loadWorkspaceWithStatus(empty)).toEqual({ snapshot: empty, issue: null });
    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBeNull();
  });

  it('keeps a copy of a truncated workspace before the empty one replaces it', () => {
    const truncated = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths","chapter":"C","title":"Mon cours"';
    localStorage.setItem(WORKSPACE_STORAGE_KEY, truncated);

    const result = loadWorkspaceWithStatus(empty);
    expect(result.snapshot).toBe(empty);
    expect(result.issue).toMatchObject({ kind: 'unreadable', backedUp: true, protect: false, copyKey: WORKSPACE_UNREADABLE_BACKUP_KEY });

    // This is what the app does right after loading: it saves the (empty) workspace over the damaged value.
    saveWorkspace(result.snapshot);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBe(truncated);
    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBe(truncated);
  });

  it('recognises a workspace written by a newer version and keeps it', () => {
    const newer = JSON.stringify({ version: 2, lessons: [{ id: 'a', subject: 'S', chapter: 'C', title: 'Mon cours', teacher: '', duration: '0', date: 'd', progress: 0 }] });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, newer);

    // A newer version owns this data: it is protected, not just copied.
    expect(loadWorkspaceWithStatus(empty).issue).toMatchObject({ kind: 'newer-version', backedUp: true, protect: true });
    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBe(newer);
  });

  it('does not duplicate the copy on repeated loads and keeps distinct originals', () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, '{broken');
    loadWorkspaceWithStatus(empty);
    loadWorkspaceWithStatus(empty);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, '{another broken');
    loadWorkspaceWithStatus(empty);

    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBe('{broken');
    expect(localStorage.getItem(`${WORKSPACE_UNREADABLE_BACKUP_KEY}.1`)).toBe('{another broken');
    expect(localStorage.getItem(`${WORKSPACE_UNREADABLE_BACKUP_KEY}.2`)).toBeNull();
  });

  it('reports that no copy was kept when storage refuses the write', () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, '{broken');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith(WORKSPACE_UNREADABLE_BACKUP_KEY)) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    try {
      const issue = loadWorkspaceWithStatus(empty).issue;
      // No copy could be kept, so the original must not be replaced: it is protected and offered as raw text.
      expect(issue).toMatchObject({ kind: 'unreadable', backedUp: false, protect: true, raw: '{broken' });
      expect(readWorkspaceCopy(issue!)).toBe('{broken');
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('does not treat the native bootstrap row as damage', () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 1, bootstrap: true }));
    expect(loadWorkspaceWithStatus(empty).issue).toBeNull();
    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBeNull();
  });

  it('flags a snapshot that silently lost entries and keeps the original', () => {
    const lesson = { id: 'a', subject: 'S', chapter: 'C', title: 'Mon cours', teacher: '', duration: '0', date: 'd', progress: 0 };
    const goodSegment = { id: 's1', timestamp: '00:00', speaker: 'P', text: 'Bonjour', status: 'verified' };
    const raw = JSON.stringify({
      version: 1, activeLessonId: 'a', lessons: [lesson, { id: 'broken-lesson' }], resources: [], transcript: [], chat: [], artifacts: [],
      lessonWorkspaces: { a: { resources: [], transcript: [goodSegment, { id: 's2', text: 42 }], chat: [], artifacts: [] } },
    });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);

    const { snapshot, issue } = loadWorkspaceWithStatus(empty);
    expect(issue).toMatchObject({ kind: 'partial', backedUp: true, protect: false });
    expect(snapshot.lessons.map((item) => item.id)).toEqual(['a']);
    expect(snapshot.lessonWorkspaces?.a.transcript).toHaveLength(1);
    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBe(raw);
  });

  it('does not flag a clean snapshot', () => {
    const lesson = { id: 'a', subject: 'S', chapter: 'C', title: 'Mon cours', teacher: '', duration: '0', date: 'd', progress: 0 };
    saveWorkspace({ ...empty, activeLessonId: 'a', lessons: [lesson], lessonWorkspaces: { a: { resources: [], transcript: [], chat: [], artifacts: [] } } });
    expect(loadWorkspaceWithStatus(empty).issue).toBeNull();
  });
});
