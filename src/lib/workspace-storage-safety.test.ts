import { beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceWithStatus, saveWorkspace, WORKSPACE_STORAGE_KEY, WORKSPACE_UNREADABLE_BACKUP_KEY, type WorkspaceSnapshot } from './workspace-storage';

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
    expect(result.issue).toEqual({ kind: 'unreadable', backedUp: true });

    // This is what the app does right after loading: it saves the (empty) workspace over the damaged value.
    saveWorkspace(result.snapshot);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBe(truncated);
    expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBe(truncated);
  });

  it('recognises a workspace written by a newer version and keeps it', () => {
    const newer = JSON.stringify({ version: 2, lessons: [{ id: 'a', subject: 'S', chapter: 'C', title: 'Mon cours', teacher: '', duration: '0', date: 'd', progress: 0 }] });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, newer);

    expect(loadWorkspaceWithStatus(empty).issue).toEqual({ kind: 'newer-version', backedUp: true });
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
      expect(loadWorkspaceWithStatus(empty).issue).toEqual({ kind: 'unreadable', backedUp: false });
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
