import { beforeEach, describe, expect, it } from 'vitest';
import { createSyntheticWorkspace } from '../test/synthetic-workspace';
import { loadWorkspace, saveWorkspace, serializeWorkspaceSnapshot, WORKSPACE_STORAGE_KEY, type WorkspaceSnapshot } from './workspace-storage';

const empty: WorkspaceSnapshot = { activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] };
const legacyBytes = (snapshot: WorkspaceSnapshot) => JSON.stringify({ version: 1, ...snapshot }).length;

describe('compact browser snapshot', () => {
  beforeEach(() => localStorage.clear());

  it('does not repeat the active course at the top level when a per-course map exists', () => {
    const snapshot = createSyntheticWorkspace({ lessons: 3, segmentsPerLesson: 60 });
    const stored = JSON.parse(serializeWorkspaceSnapshot(snapshot)) as Record<string, unknown>;

    for (const key of ['resources', 'transcript', 'chat', 'artifacts']) expect(stored).not.toHaveProperty(key);
    expect(Object.keys(stored.lessonWorkspaces as object)).toHaveLength(3);
    expect(stored).toMatchObject({ version: 1, activeLessonId: snapshot.activeLessonId });
  });

  it('keeps the flat legacy shape when there is no per-course map', () => {
    const snapshot: WorkspaceSnapshot = {
      ...empty,
      activeLessonId: 'a',
      lessons: [{ id: 'a', subject: 'S', chapter: 'C', title: 'T', teacher: '', duration: '0', date: 'd', progress: 0 }],
      chat: [{ id: 'm', role: 'user', content: 'Hi' }],
    };
    expect(JSON.parse(serializeWorkspaceSnapshot(snapshot))).toMatchObject({ chat: [{ id: 'm' }] });
  });

  it('round-trips a large workspace and rebuilds the top-level lists from the active course', () => {
    const snapshot = createSyntheticWorkspace({ lessons: 5, segmentsPerLesson: 120 });
    expect(saveWorkspace(snapshot)).toBe(true);
    const loaded = loadWorkspace(empty);
    expect(loaded).toEqual(snapshot);
    expect(loaded.transcript).toHaveLength(120);
    expect(loaded.transcript).toBe(loaded.lessonWorkspaces![snapshot.activeLessonId].transcript);
  });

  it('still reads the older shape that repeats the active course, and the next save compacts it', () => {
    const snapshot = createSyntheticWorkspace({ lessons: 3, segmentsPerLesson: 40 });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 1, ...snapshot }));
    const loaded = loadWorkspace(empty);
    expect(loaded).toEqual(snapshot);

    const before = localStorage.getItem(WORKSPACE_STORAGE_KEY)!.length;
    saveWorkspace(loaded);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)!.length).toBeLessThan(before);
    expect(loadWorkspace(empty)).toEqual(snapshot);
  });

  it('reads the top-level lists of the older shape when they differ from the per-course copy', () => {
    const snapshot = createSyntheticWorkspace({ lessons: 2, segmentsPerLesson: 10 });
    const extra = { id: 'older-question', role: 'user' as const, content: 'Only in the top-level copy' };
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 1, ...snapshot, chat: [extra] }));
    expect(loadWorkspace(empty).chat).toEqual([extra]);
  });

  it('writes a smaller snapshot for a realistic workspace', () => {
    // One long course (the one being studied) next to several shorter ones.
    const snapshot = createSyntheticWorkspace({ lessons: 6, segmentsPerLesson: 80, activeSegments: 600 });
    const before = legacyBytes(snapshot);
    const after = serializeWorkspaceSnapshot(snapshot).length;
    console.info(`[size] mixed workspace: legacy ${(before / 1024).toFixed(0)} KiB, compact ${(after / 1024).toFixed(0)} KiB, saved ${Math.round((1 - after / before) * 100)}%`);
    expect(after).toBeLessThan(before * 0.85);
  });

  it('removes the whole duplicate of a single large course', () => {
    const snapshot = createSyntheticWorkspace({ lessons: 1, segmentsPerLesson: 600 });
    const before = legacyBytes(snapshot);
    const after = serializeWorkspaceSnapshot(snapshot).length;
    console.info(`[size] single course: legacy ${(before / 1024).toFixed(0)} KiB, compact ${(after / 1024).toFixed(0)} KiB, saved ${Math.round((1 - after / before) * 100)}%`);
    expect(after).toBeLessThan(before * 0.72);
  });
});
