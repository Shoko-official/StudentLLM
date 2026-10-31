import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureWorkspace as createFixtureWithVersion } from '../test/workspace-fixture';
import { createSyntheticWorkspace } from '../test/synthetic-workspace';
import {
  DEFAULT_LOAD_TIMEOUT_MS,
  fingerprintWorkspace,
  openBrowserWorkspace,
  openLocalStorageWorkspace,
  WORKSPACE_IDB_ACTIVE_KEY,
  type BrowserBootstrap,
} from './browser-workspace-store';
import { META_KEY, openWorkspaceDb, parseMeta, SNAPSHOT_KEY, WorkspaceIdb } from './workspace-idb';
import { RECORDING_RECOVERY_STORAGE_KEY } from './recording-recovery';
import { WORKSPACE_STORAGE_KEY, WORKSPACE_UNREADABLE_BACKUP_KEY, WORKSPACE_MIGRATION_BACKUP_KEY, type WorkspaceSnapshot } from './workspace-storage';
import { WorkspaceIdbError } from './workspace-idb';

const createFixtureWorkspace = (): WorkspaceSnapshot => {
  const { version: _version, ...snapshot } = createFixtureWithVersion();
  return snapshot;
};
const empty: WorkspaceSnapshot = { activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] };
const legacyRaw = (snapshot: WorkspaceSnapshot) => JSON.stringify({ version: 1, ...snapshot });
const open = (factory: IDBFactory, deps: Parameters<typeof openBrowserWorkspace>[1] = {}) => openBrowserWorkspace(empty, { indexedDb: factory, ...deps });

async function inspect<T>(factory: IDBFactory, read: (db: WorkspaceIdb) => Promise<T>): Promise<T> {
  const db = await openWorkspaceDb(factory);
  try {
    return await read(db);
  } finally {
    db.close();
  }
}
const storedSnapshot = (factory: IDBFactory) => inspect(factory, (db) => db.get(SNAPSHOT_KEY));
const storedMeta = (factory: IDBFactory) => inspect(factory, async (db) => parseMeta(await db.get(META_KEY)));

let opened: BrowserBootstrap[] = [];
const track = async (bootstrap: Promise<BrowserBootstrap>) => {
  const result = await bootstrap;
  opened.push(result);
  return result;
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  opened = [];
});
afterEach(() => {
  for (const bootstrap of opened) bootstrap.store.dispose();
  vi.restoreAllMocks();
});

describe('migration from localStorage to IndexedDB', () => {
  it('copies an existing localStorage workspace, verifies the copy, records the migration and keeps the original', async () => {
    const factory = new IDBFactory();
    const workspace = createFixtureWorkspace();
    const raw = legacyRaw(workspace);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);

    const result = await track(open(factory));

    expect(result.snapshot).toEqual(workspace);
    expect(result.issue).toBeNull();
    expect(result.store.backend).toBe('indexeddb');
    // A byte-exact copy, not a re-serialization.
    expect(await storedSnapshot(factory)).toBe(raw);
    expect(await storedMeta(factory)).toMatchObject({ version: 1, migrated: { from: 'localStorage', bytes: raw.length, fingerprint: fingerprintWorkspace(raw) } });
    // The original is left exactly as it was, and the flag says IndexedDB is now the home of the workspace.
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
    expect(Date.parse(localStorage.getItem(WORKSPACE_IDB_ACTIVE_KEY)!)).not.toBeNaN();
  });

  it('never writes to or removes the localStorage workspace, during the migration or later saves', async () => {
    const factory = new IDBFactory();
    const workspace = createFixtureWorkspace();
    const raw = legacyRaw(workspace);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');

    const result = await track(open(factory));
    await result.store.save({ ...result.snapshot, activeLessonId: 'fixture-context' });

    expect(setItem.mock.calls.filter(([key]) => key === WORKSPACE_STORAGE_KEY)).toEqual([]);
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
  });

  it('does not migrate twice: a rerun reads IndexedDB and leaves the migration record alone', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    await track(open(factory, { now: () => 1000 }));
    const firstMeta = await storedMeta(factory);

    const second = await track(open(factory, { now: () => 2000 }));

    expect(second.issue).toBeNull();
    expect(await storedSnapshot(factory)).toBe(raw);
    expect(await storedMeta(factory)).toEqual(firstMeta);
  });

  it('prefers IndexedDB when both hold a workspace, and keeps a localStorage value that changed after the migration', async () => {
    const factory = new IDBFactory();
    const migrated = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(migrated));
    const first = await track(open(factory));
    await first.store.save({ ...first.snapshot, lessons: first.snapshot.lessons.slice(0, 2) });
    first.store.dispose();

    // An older version of the app wrote the localStorage value afterwards.
    const older = { ...migrated, lessons: migrated.lessons.slice(0, 1) };
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(older));
    const second = await track(open(factory));

    expect(second.snapshot.lessons).toHaveLength(2);
    expect(second.issue).toMatchObject({ kind: 'older-copy', backedUp: true, protect: false, copyStore: 'indexeddb' });
    expect(await second.store.readCopy(second.issue!)).toBe(legacyRaw(older));
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(legacyRaw(older));

    // Told once: the same value is not reported again.
    second.store.dispose();
    const third = await track(open(factory));
    expect(third.issue).toBeNull();
  });

  it('says nothing when the localStorage value is the one that was migrated', async () => {
    const factory = new IDBFactory();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(createFixtureWorkspace()));
    const first = await track(open(factory));
    await first.store.save({ ...first.snapshot, activeLessonId: 'fixture-context' });
    first.store.dispose();

    const second = await track(open(factory));
    expect(second.issue).toBeNull();
    expect(second.snapshot.activeLessonId).toBe('fixture-context');
  });

  it('starts empty on a first launch and writes nothing until the first save', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));

    expect(result.snapshot).toBe(empty);
    expect(result.issue).toBeNull();
    expect(await storedSnapshot(factory)).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('finishes an interrupted migration: the copy exists but was never recorded', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    // The first start copied the workspace and died before it recorded anything.
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, raw));
    expect(await storedMeta(factory)).toBeUndefined();

    const result = await track(open(factory));

    expect(result.snapshot).toEqual(createFixtureWorkspace());
    expect(result.issue).toBeNull();
    expect(await storedMeta(factory)).toMatchObject({ migrated: { fingerprint: fingerprintWorkspace(raw) } });
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
  });

  it('uses the verified copy even when the migration record cannot be written, and records it at the next start', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    const failing = vi.spyOn(WorkspaceIdb.prototype, 'markMigrated').mockRejectedValue(new Error('meta write failed'));

    const first = await track(open(factory));
    expect(first.snapshot).toEqual(createFixtureWorkspace());
    expect(await storedMeta(factory)).toBeUndefined();
    first.store.dispose();
    failing.mockRestore();

    await track(open(factory));
    expect(await storedMeta(factory)).toMatchObject({ migrated: { fingerprint: fingerprintWorkspace(raw) } });
  });

  it('removes its own unverified copy and keeps working from localStorage when the read-back never matches', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    // The copy reads back as something else, every time.
    const realRead = WorkspaceIdb.prototype.getSnapshotAndMeta;
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(async function (this: WorkspaceIdb) {
      const state = await realRead.call(this);
      return state.snapshot === raw ? { ...state, snapshot: 'something else' } : state;
    });

    const result = await track(open(factory));

    expect(result.store.backend).toBe('localstorage');
    expect(result.unavailable).toEqual({ reason: 'indexeddb-unavailable', protect: false });
    expect(result.snapshot).toEqual(createFixtureWorkspace());
    vi.restoreAllMocks();
    expect(await storedSnapshot(factory)).toBeUndefined();
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
    expect(localStorage.getItem(WORKSPACE_IDB_ACTIVE_KEY)).toBeNull();
  });

  it('a failed read-back never deletes what another tab saved in the meantime', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    // Tab B is already open (first launch, nothing stored yet) when tab A starts migrating.
    const other = await track(open(factory));
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    const newer = { ...createFixtureWorkspace(), activeLessonId: 'fixture-context' };

    // Tab B saves right after tab A copied the workspace and before A reads its copy back.
    const realPut = WorkspaceIdb.prototype.putIfAbsent;
    let done = false;
    vi.spyOn(WorkspaceIdb.prototype, 'putIfAbsent').mockImplementation(async function (this: WorkspaceIdb, key: string, value: unknown) {
      const written = await realPut.call(this, key, value);
      if (!done && key === SNAPSHOT_KEY && written) {
        done = true;
        await other.store.save(newer);
      }
      return written;
    });
    const a = await track(open(factory));

    // A's copy was replaced by B's newer work: it must not be removed, and A must end up showing it.
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('fixture-context');
    expect(a.snapshot.activeLessonId).toBe('fixture-context');
    expect(a.store.backend).toBe('indexeddb');
  });

  it('two tabs migrating at once end with one copy of the same workspace', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);

    const [a, b] = await Promise.all([track(open(factory)), track(open(factory))]);

    expect(a.snapshot).toEqual(createFixtureWorkspace());
    expect(b.snapshot).toEqual(createFixtureWorkspace());
    expect(await storedSnapshot(factory)).toBe(raw);
    expect((await storedMeta(factory))?.migrated?.fingerprint).toBe(fingerprintWorkspace(raw));
  });

  it('does not overwrite newer IndexedDB work when a slower tab starts its migration late', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    const first = await track(open(factory));
    await first.store.save({ ...first.snapshot, activeLessonId: 'fixture-context' });
    first.store.dispose();
    const newer = String(await storedSnapshot(factory));

    // The slow tab read "IndexedDB is empty" a moment before the first tab wrote. Its copy must not replace the newer data.
    const realRead = WorkspaceIdb.prototype.getSnapshotAndMeta;
    let stale = true;
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(async function (this: WorkspaceIdb) {
      if (stale) {
        stale = false;
        return { snapshot: undefined, meta: undefined };
      }
      return realRead.call(this);
    });
    const slow = await track(open(factory));

    expect(slow.snapshot.activeLessonId).toBe('fixture-context');
    expect(await storedSnapshot(factory)).toBe(newer);
  });

  it('migrates a readable workspace whose demo content is cleaned up, keeps a backup in IndexedDB and saves the cleaned one', async () => {
    const factory = new IDBFactory();
    const demo = {
      activeLessonId: 'transformers-06',
      lessons: [{ id: 'transformers-06', subject: 'Machine Learning', chapter: 'Transformers', title: 'Attention & Scaled Dot-Product', teacher: 'Prof. Yann LeCun', duration: '01:32:47', date: '15 May 2025', progress: 72 }],
      resources: [{ id: 'r1', name: 'transcript.txt', meta: 'Text · 126 KB', kind: 'transcript' as const }],
      transcript: [],
      chat: [],
      artifacts: [],
    };
    const raw = legacyRaw(demo);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);

    const result = await track(open(factory));

    expect(result.snapshot.resources).toEqual([]);
    expect(await inspect(factory, (db) => db.get(WORKSPACE_MIGRATION_BACKUP_KEY))).toBe(raw);
    expect(JSON.parse(String(await storedSnapshot(factory))).resources ?? []).toEqual([]);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
  });
});

describe('unreadable stored workspaces in IndexedDB', () => {
  const lesson = { id: 'a', subject: 'S', chapter: 'C', title: 'Mon cours', teacher: '', duration: '0', date: 'd', progress: 0 };

  it('keeps a copy of a damaged IndexedDB value before it can be replaced, and offers it for download', async () => {
    const factory = new IDBFactory();
    const damaged = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"';
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, damaged));

    const result = await track(open(factory));

    expect(result.snapshot).toBe(empty);
    expect(result.issue).toMatchObject({ kind: 'unreadable', backedUp: true, protect: false, copyKey: WORKSPACE_UNREADABLE_BACKUP_KEY, copyStore: 'indexeddb' });
    expect(await result.store.readCopy(result.issue!)).toBe(damaged);
    // Nothing is written until the first save, and then the copy is still there.
    expect(await storedSnapshot(factory)).toBe(damaged);
    await result.store.save({ ...empty, activeLessonId: 'a', lessons: [lesson], lessonWorkspaces: { a: { resources: [], transcript: [], chat: [], artifacts: [] } } });
    expect(await storedSnapshot(factory)).not.toBe(damaged);
    expect(await inspect(factory, (db) => db.get(WORKSPACE_UNREADABLE_BACKUP_KEY))).toBe(damaged);
  });

  it('shows the localStorage workspace from before the upgrade when the IndexedDB value is damaged', async () => {
    const factory = new IDBFactory();
    const workspace = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(workspace));
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, '{truncated'));

    const result = await track(open(factory));

    expect(result.snapshot).toEqual(workspace);
    expect(result.issue).toMatchObject({ kind: 'unreadable', backedUp: true, restoredFromLegacy: true });
    expect(await result.store.readCopy(result.issue!)).toBe('{truncated');
  });

  it('does not touch a value written by a newer version and pauses saving', async () => {
    const factory = new IDBFactory();
    const newer = JSON.stringify({ version: 2, lessons: [lesson] });
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, newer));
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(createFixtureWorkspace()));

    const result = await track(open(factory));

    expect(result.issue).toMatchObject({ kind: 'newer-version', protect: true, backedUp: true });
    // A newer version owns the data: the older localStorage copy is not put in its place.
    expect(result.snapshot).toBe(empty);
    expect(await result.store.save({ ...empty, activeLessonId: 'x' })).toBe(false);
    expect(await storedSnapshot(factory)).toBe(newer);
  });

  it('protects the original when no copy can be kept, and writes again only after the student chose to start empty', async () => {
    const factory = new IDBFactory();
    const damaged = '{broken';
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, damaged));
    vi.spyOn(WorkspaceIdb.prototype, 'putAll').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));

    const result = await track(open(factory));

    expect(result.issue).toMatchObject({ kind: 'unreadable', backedUp: false, protect: true, raw: damaged });
    expect(await result.store.readCopy(result.issue!)).toBe(damaged);
    expect(await result.store.save({ ...empty, activeLessonId: 'x' })).toBe(false);
    expect(await storedSnapshot(factory)).toBe(damaged);

    result.store.setProtected(false);
    expect(await result.store.save({ ...empty, activeLessonId: 'x' })).toBe(true);
    expect(await storedSnapshot(factory)).not.toBe(damaged);
  });

  it('flags a snapshot that silently lost entries and keeps the original in IndexedDB', async () => {
    const factory = new IDBFactory();
    const goodSegment = { id: 's1', timestamp: '00:00', speaker: 'P', text: 'Bonjour', status: 'verified' };
    const raw = JSON.stringify({
      version: 1, activeLessonId: 'a', lessons: [lesson, { id: 'broken-lesson' }],
      lessonWorkspaces: { a: { resources: [], transcript: [goodSegment, { id: 's2', text: 42 }], chat: [], artifacts: [] } },
    });
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, raw));

    const result = await track(open(factory));

    expect(result.issue).toMatchObject({ kind: 'partial', backedUp: true, protect: false, copyStore: 'indexeddb' });
    expect(result.snapshot.lessonWorkspaces?.a.transcript).toHaveLength(1);
    expect(await result.store.readCopy(result.issue!)).toBe(raw);
  });

  it('does not duplicate the copy on repeated loads', async () => {
    const factory = new IDBFactory();
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, '{broken'));
    (await track(open(factory))).store.dispose();
    (await track(open(factory))).store.dispose();

    const keys = await inspect(factory, (db) => db.keysWithPrefix(WORKSPACE_UNREADABLE_BACKUP_KEY));
    expect(keys).toEqual([WORKSPACE_UNREADABLE_BACKUP_KEY]);
  });

  it('keeps the interrupted-recording manifest in mind when deciding to clean up the demo workspace', async () => {
    const factory = new IDBFactory();
    const demoLesson = { id: 'transformers-06', subject: 'Machine Learning', chapter: 'Transformers', title: 'Attention & Scaled Dot-Product', teacher: 'Prof. Yann LeCun', duration: '01:32:47', date: '15 May 2025', progress: 72 };
    const raw = legacyRaw({ ...empty, activeLessonId: demoLesson.id, lessons: [demoLesson] });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    localStorage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, recordings: [{ recordingId: 'rec-1', lessonId: demoLesson.id, lessonTitle: 'x', startedAt: 1 }] }));

    const result = await track(open(factory));

    // The lesson has pending audio, so it must not be dropped as "demo content".
    expect(result.snapshot.lessons).toEqual([demoLesson]);
  });
});

describe('when IndexedDB cannot be used', () => {
  it('falls back to localStorage with its existing behavior when there is no IndexedDB', async () => {
    const workspace = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(workspace));

    const result = await track(openBrowserWorkspace(empty, { indexedDb: null }));

    expect(result.store.backend).toBe('localstorage');
    expect(result.unavailable).toEqual({ reason: 'indexeddb-unavailable', protect: false });
    expect(result.snapshot).toEqual(workspace);
  });

  const failingFactories: Array<[string, () => IDBFactory]> = [
    ['open throws (a blocked or private window)', () => ({ open: () => { throw new DOMException('denied', 'SecurityError'); } }) as unknown as IDBFactory],
    ['open fails', () => ({
      open: () => {
        const request: Partial<IDBOpenDBRequest> & { error: DOMException } = { error: new DOMException('A mutation operation was attempted on a database that did not allow mutations.', 'InvalidStateError') };
        setTimeout(() => (request.onerror as (() => void) | null)?.(), 0);
        return request as IDBOpenDBRequest;
      },
    }) as unknown as IDBFactory],
    ['the open never completes (another tab holds an old connection)', () => ({ open: () => ({}) as IDBOpenDBRequest }) as unknown as IDBFactory],
  ];

  it.each(failingFactories)('uses localStorage and the existing alerts when %s', async (_name, createFactory) => {
    const workspace = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(workspace));

    const result = await track(open(createFactory(), { openTimeoutMs: 20 }));

    expect(result.store.backend).toBe('localstorage');
    expect(result.unavailable).toEqual({ reason: _name.startsWith('the open never') ? 'indexeddb-timeout' : 'indexeddb-unavailable', protect: false });
    expect(result.snapshot).toEqual(workspace);
    // Saving keeps working through localStorage, so the existing quota alert path applies.
    expect(await result.store.save({ ...result.snapshot, activeLessonId: 'fixture-context' })).toBe(true);
    expect(JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!).activeLessonId).toBe('fixture-context');
  });

  it('reports a failed save through localStorage when its quota is exceeded', async () => {
    const result = await track(open({ open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(await result.store.save(createFixtureWorkspace())).toBe(false);
  });

  it('pauses saving and shows the older copy when IndexedDB held the workspace but cannot be opened now', async () => {
    const staleCopy = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, staleCopy);
    localStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, '1');

    const result = await track(open({ open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory));

    expect(result.unavailable).toEqual({ reason: 'indexeddb-blocked', protect: true });
    expect(result.snapshot).toEqual(createFixtureWorkspace());
    // The stale copy must not be updated: it would later look newer than it is.
    expect(await result.store.save({ ...result.snapshot, activeLessonId: 'fixture-context' })).toBe(false);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(staleCopy);
  });

  it('works without localStorage at all', async () => {
    const result = await track(openBrowserWorkspace(empty, { indexedDb: new IDBFactory(), localStorage: undefined }));
    expect(result.store.backend).toBe('indexeddb');
    expect(await result.store.save({ ...empty, activeLessonId: 'x' })).toBe(true);
  });
});

describe('saving to IndexedDB', () => {
  it('stores the compact snapshot and returns what was saved on the next load', async () => {
    const factory = new IDBFactory();
    const first = await track(open(factory));
    const workspace = createSyntheticWorkspace({ lessons: 3, segmentsPerLesson: 50 });

    expect(await first.store.save(workspace)).toBe(true);
    expect(JSON.parse(String(await storedSnapshot(factory)))).not.toHaveProperty('transcript');
    first.store.dispose();

    const second = await track(open(factory));
    expect(second.snapshot).toEqual(workspace);
    expect(second.issue).toBeNull();
  });

  it('stores a workspace far beyond the 5 MB localStorage ceiling', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const workspace = createSyntheticWorkspace({ lessons: 3, segmentsPerLesson: 1500, activeSegments: 3500 });
    expect(JSON.stringify(workspace).length).toBeGreaterThan(6 * 1024 * 1024);

    expect(await result.store.save(workspace)).toBe(true);
    result.store.dispose();
    expect((await track(open(factory))).snapshot).toEqual(workspace);
  }, 30_000);

  it('reports a full store as a failed save and keeps the previous version', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const before = createSyntheticWorkspace({ lessons: 2, segmentsPerLesson: 20 });
    expect(await result.store.save(before)).toBe(true);
    const stored = await storedSnapshot(factory);

    // Chromium reports a full disk when the transaction commits, as an abort whose error is QuotaExceededError.
    const realPut = IDBObjectStore.prototype.put;
    let full = true;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = realPut.call(this, value, key);
      if (full && key === SNAPSHOT_KEY) {
        const transaction = this.transaction;
        Object.defineProperty(transaction, 'error', { configurable: true, get: () => new DOMException('The quota has been exceeded.', 'QuotaExceededError') });
        transaction.abort();
      }
      return request;
    });
    const bigger = createSyntheticWorkspace({ lessons: 2, segmentsPerLesson: 21 });
    expect(await result.store.save(bigger)).toBe(false);
    expect(await storedSnapshot(factory)).toBe(stored);

    // Once there is space again, the next save goes through: the alert clears.
    full = false;
    expect(await result.store.save(bigger)).toBe(true);
    expect(await storedSnapshot(factory)).not.toBe(stored);
  });

  it('reports a quota error thrown by the request itself', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(await result.store.save(createFixtureWorkspace())).toBe(false);
  });

  it('refuses a snapshot above the size limit instead of writing it', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const huge = { ...createFixtureWorkspace(), lessonWorkspaces: { x: { resources: [], transcript: [{ id: 't', timestamp: '0', speaker: 's', text: 'x'.repeat(17 * 1024 * 1024) }], chat: [], artifacts: [] } } };
    expect(await result.store.save(huge)).toBe(false);
    expect(await storedSnapshot(factory)).toBeUndefined();
  });

  it('does not write, or bump the version, when the state is the one that was loaded', async () => {
    const factory = new IDBFactory();
    const first = await track(open(factory));
    await first.store.save(createFixtureWorkspace());
    first.store.dispose();
    const versionBefore = (await storedMeta(factory))!.version;

    const second = await track(open(factory));
    const channel = new BroadcastChannel('studentllm.workspace.v1');
    const heard = vi.fn();
    channel.onmessage = heard;
    // The app saves what it just loaded as soon as it mounts.
    expect(await second.store.save(second.snapshot)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    channel.close();

    expect((await storedMeta(factory))!.version).toBe(versionBefore);
    expect(heard).not.toHaveBeenCalled();
  });

  it('keeps only the newest of several saves that queue up, and tells every caller it was stored', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const compareAndSet = vi.spyOn(WorkspaceIdb.prototype, 'compareAndSet');
    const states = Array.from({ length: 6 }, (_, index) => ({ ...createFixtureWorkspace(), activeLessonId: `state-${index}` }));

    const results = await Promise.all(states.map((state) => result.store.save(state)));

    expect(results).toEqual(states.map(() => true));
    expect(compareAndSet.mock.calls.length).toBeLessThan(states.length);
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('state-5');
  });

  it('does not write anything before the load has finished', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realRead = WorkspaceIdb.prototype.getSnapshotAndMeta;
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(async function (this: WorkspaceIdb) {
      await gate;
      return realRead.call(this);
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');

    const pending = track(open(factory));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still loading: no store exists yet, and nothing has been written anywhere.
    expect(setItem).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();

    release();
    const result = await pending;
    expect(result.snapshot).toEqual(createFixtureWorkspace());
  });
});

describe('two tabs', () => {
  const twoTabs = async (factory: IDBFactory, deps: Parameters<typeof openBrowserWorkspace>[1] = {}) => {
    const first = await track(open(factory, deps));
    await first.store.save(createFixtureWorkspace());
    const a = await track(open(factory, deps));
    const b = await track(open(factory, deps));
    return { a, b };
  };

  it('tells the other tab at once through BroadcastChannel, and writes nothing from the stale tab', async () => {
    const factory = new IDBFactory();
    const { a, b } = await twoTabs(factory);
    const heard = vi.fn();
    b.store.onChangedElsewhere(heard);

    expect(await a.store.save({ ...a.snapshot, activeLessonId: 'fixture-context' })).toBe(true);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('saved-elsewhere'));

    expect(await b.store.save({ ...b.snapshot, activeLessonId: 'fixture-linear-algebra' })).toBe(false);
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('fixture-context');
  });

  it('still catches the other tab without BroadcastChannel, at the stale tab\'s next save', async () => {
    const factory = new IDBFactory();
    const { a, b } = await twoTabs(factory, { broadcastChannel: null });
    const heard = vi.fn();
    b.store.onChangedElsewhere(heard);

    expect(await a.store.save({ ...a.snapshot, activeLessonId: 'fixture-context' })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).not.toHaveBeenCalled();

    expect(await b.store.save({ ...b.snapshot, activeLessonId: 'fixture-linear-algebra' })).toBe(false);
    expect(heard).toHaveBeenCalledWith('conflict');
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('fixture-context');
  });

  it('refuses to write once it was told the data changed elsewhere, even if the version still matches', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    await result.store.save(createFixtureWorkspace());
    const stored = await storedSnapshot(factory);
    (result.store as unknown as { markStale: (reason: string) => void }).markStale('saved-elsewhere');

    expect(await result.store.save({ ...createFixtureWorkspace(), activeLessonId: 'fixture-context' })).toBe(false);
    expect(await storedSnapshot(factory)).toBe(stored);
  });

  it('lets two tabs that open the same state coexist: neither is told anything', async () => {
    const factory = new IDBFactory();
    const { a, b } = await twoTabs(factory);
    const heard = vi.fn();
    a.store.onChangedElsewhere(heard);

    expect(await b.store.save(b.snapshot)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).not.toHaveBeenCalled();
  });

  it('lets two first launches write only once', async () => {
    const factory = new IDBFactory();
    const a = await track(open(factory));
    const b = await track(open(factory));

    expect(await a.store.save({ ...empty, activeLessonId: 'from-a' })).toBe(true);
    expect(await b.store.save({ ...empty, activeLessonId: 'from-b' })).toBe(false);
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('from-a');
  });

  it('closes its connection when another tab upgrades the database, and stops saving', async () => {
    const factory = new IDBFactory();
    const first = await track(open(factory));
    const heard = vi.fn();
    first.store.onChangedElsewhere(heard);

    // A newer version of the app in another tab opens the database at a higher version.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('studentllm-workspace', 2);
      request.onupgradeneeded = () => undefined;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked: the old tab did not release its connection'));
    });

    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('version-change'));
    expect(await first.store.save(createFixtureWorkspace())).toBe(false);
    upgraded.close();
  });

  it('treats a deleted database (browser data cleared) as a change, also for a listener that subscribes late', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const early = vi.fn();
    result.store.onChangedElsewhere(early);

    await new Promise((resolve) => {
      const request = factory.deleteDatabase('studentllm-workspace');
      request.onsuccess = resolve;
      request.onerror = resolve;
    });
    await vi.waitFor(() => expect(early).toHaveBeenCalledWith('version-change'));

    const late = vi.fn();
    result.store.onChangedElsewhere(late);
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith('version-change'));
    expect(await result.store.save(createFixtureWorkspace())).toBe(false);
  });
});

describe('the localStorage path', () => {
  it('detects another tab through the storage event, as before', () => {
    const bootstrap = openLocalStorageWorkspace(empty);
    const heard = vi.fn();
    const stop = bootstrap.store.onChangedElsewhere(heard);

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(heard).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_STORAGE_KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps a protected original untouched', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 2, lessons: [] }));
    const bootstrap = openLocalStorageWorkspace(empty);
    expect(bootstrap.issue?.protect).toBe(true);
    expect(await bootstrap.store.save({ ...empty, activeLessonId: 'x' })).toBe(false);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(JSON.stringify({ version: 2, lessons: [] }));
  });
});

describe('reading the snapshot and its version', () => {
  it('reads both in one transaction, so no other tab can save between them', async () => {
    const factory = new IDBFactory();
    const first = await track(open(factory));
    await first.store.save(createFixtureWorkspace());
    first.store.dispose();
    const readKeys: Array<{ transaction: IDBTransaction; key: unknown }> = [];
    const realGet = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      readKeys.push({ transaction: this.transaction, key });
      return realGet.call(this, key);
    });

    await track(open(factory));

    const sharing = readKeys.filter((entry) => entry.key === SNAPSHOT_KEY).some((entry) => readKeys.some((other) => other.transaction === entry.transaction && other.key === META_KEY));
    expect(sharing).toBe(true);
  });

  it('a tab that saves between the two reads cannot leave the loader with an old snapshot and a new version', async () => {
    const factory = new IDBFactory();
    const first = await track(open(factory));
    await first.store.save(createFixtureWorkspace());
    const other = await track(open(factory));
    // As soon as the loader reads the snapshot, another tab commits a newer one.
    let fired = false;
    const realGet = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = realGet.call(this, key);
      if (!fired && key === SNAPSHOT_KEY && this.transaction.mode === 'readonly') {
        fired = true;
        void other.store.save({ ...createFixtureWorkspace(), activeLessonId: 'fixture-context' });
      }
      return request;
    });
    const loader = await track(open(factory));
    vi.restoreAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The loader's pair is consistent (old snapshot, old version), so its own save is refused instead of overwriting.
    expect(await loader.store.save({ ...createFixtureWorkspace(), activeLessonId: 'fixture-linear-algebra' })).toBe(false);
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('fixture-context');
  });

  it('the first launch takes its version from the same read: a tab that saves first wins', async () => {
    const factory = new IDBFactory();
    const a = await track(open(factory));
    const b = await track(open(factory));
    expect(await a.store.save({ ...empty, activeLessonId: 'from-a' })).toBe(true);
    expect(await b.store.save({ ...empty, activeLessonId: 'from-b' })).toBe(false);
  });
});

describe('a load that never finishes', () => {
  it('gives up after the load timeout and works from localStorage with a notice', async () => {
    const factory = new IDBFactory();
    const workspace = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(workspace));
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(() => new Promise(() => undefined));

    const result = await track(open(factory, { loadTimeoutMs: 40 }));

    expect(result.store.backend).toBe('localstorage');
    expect(result.unavailable).toEqual({ reason: 'indexeddb-timeout', protect: false });
    expect(result.snapshot).toEqual(workspace);
  });

  it('pauses saving on the stale copy when IndexedDB held the workspace', async () => {
    const factory = new IDBFactory();
    const stale = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, stale);
    localStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, '2026-01-01T00:00:00.000Z');
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(() => new Promise(() => undefined));

    const result = await track(open(factory, { loadTimeoutMs: 40 }));

    expect(result.unavailable).toEqual({ reason: 'indexeddb-blocked', protect: true });
    expect(await result.store.save({ ...result.snapshot, activeLessonId: 'fixture-context' })).toBe(false);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(stale);
  });

  it('a transaction that completes after the timeout writes nothing', async () => {
    const factory = new IDBFactory();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(createFixtureWorkspace()));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realRead = WorkspaceIdb.prototype.getSnapshotAndMeta;
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(async function (this: WorkspaceIdb) {
      await gate;
      return realRead.call(this);
    });
    await track(open(factory, { loadTimeoutMs: 30 }));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storedSnapshot(factory)).toBeUndefined();
  });
});

describe('IndexedDB was emptied after it held the workspace', () => {
  const heldSince = '2026-03-04T10:00:00.000Z';

  it('copies the older localStorage workspace but says so, with the date and a copy to download', async () => {
    const factory = new IDBFactory();
    const raw = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    localStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, heldSince);

    const result = await track(open(factory));

    expect(result.snapshot).toEqual(createFixtureWorkspace());
    expect(result.issue).toMatchObject({ kind: 'storage-reset', backedUp: true, protect: false, copyKey: WORKSPACE_STORAGE_KEY, since: heldSince });
    expect(await result.store.readCopy(result.issue!)).toBe(raw);
    expect(await storedSnapshot(factory)).toBe(raw);
  });

  it('says so when localStorage is empty too, instead of a silent first launch', async () => {
    const factory = new IDBFactory();
    localStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, heldSince);

    const result = await track(open(factory));

    expect(result.snapshot).toBe(empty);
    expect(result.issue).toMatchObject({ kind: 'storage-reset', backedUp: false, protect: false });
    expect(result.issue?.copyKey).toBeUndefined();
  });

  it('is silent on a real first launch', async () => {
    const result = await track(open(new IDBFactory()));
    expect(result.issue).toBeNull();
  });

  it('also notices through the sessionStorage mark when localStorage could not keep the flag', async () => {
    sessionStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, heldSince);
    const result = await track(open(new IDBFactory()));
    expect(result.issue).toMatchObject({ kind: 'storage-reset', backedUp: false });
  });
});

describe('remembering that IndexedDB holds the workspace', () => {
  const broken = () => ({ open: () => { throw new DOMException('denied', 'SecurityError'); } }) as unknown as IDBFactory;

  it('keeps a sessionStorage mark, retries and warns when localStorage refuses the flag', async () => {
    const factory = new IDBFactory();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(createFixtureWorkspace()));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const realSet = Storage.prototype.setItem;
    const attempts: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === WORKSPACE_IDB_ACTIVE_KEY && this === localStorage) {
        attempts.push(key);
        throw new DOMException('full', 'QuotaExceededError');
      }
      return realSet.call(this, key, value);
    });

    const first = await track(open(factory));

    expect(first.snapshot).toEqual(createFixtureWorkspace());
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not record'));
    expect(sessionStorage.getItem(WORKSPACE_IDB_ACTIVE_KEY)).toBeTruthy();
    // Even with no flag in localStorage, a later failure to open IndexedDB does not fall back to the stale copy.
    vi.restoreAllMocks();
    const later = await track(open(broken()));
    expect(later.unavailable).toEqual({ reason: 'indexeddb-blocked', protect: true });
  });

  it('asks the browser which databases exist when no mark survived', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(createFixtureWorkspace()));
    const withDatabase = { ...broken(), databases: async () => [{ name: 'studentllm-workspace', version: 1 }] } as unknown as IDBFactory;
    const result = await track(open(withDatabase));
    expect(result.unavailable).toEqual({ reason: 'indexeddb-blocked', protect: true });

    const withoutDatabase = { ...broken(), databases: async () => [{ name: 'something-else' }] } as unknown as IDBFactory;
    const fallback = await track(open(withoutDatabase));
    expect(fallback.unavailable).toEqual({ reason: 'indexeddb-unavailable', protect: false });
  });

  it('protects the stale copy on the synchronous path too, when there is no indexedDB at all', async () => {
    const stale = legacyRaw(createFixtureWorkspace());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, stale);
    localStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, '2026-01-01T00:00:00.000Z');

    const result = openLocalStorageWorkspace(empty);

    expect(result.unavailable).toEqual({ reason: 'indexeddb-blocked', protect: true });
    expect(await result.store.save({ ...empty, activeLessonId: 'x' })).toBe(false);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(stale);
  });
});

describe('why a save did not happen', () => {
  const huge = () => ({ ...createFixtureWorkspace(), lessonWorkspaces: { x: { resources: [], transcript: [{ id: 't', timestamp: '0', speaker: 's', text: 'x'.repeat(17 * 1024 * 1024) }], chat: [], artifacts: [] } } });

  it('tells a workspace over the size limit from a full store (IndexedDB)', async () => {
    const result = await track(open(new IDBFactory()));
    expect(await result.store.save(huge())).toBe(false);
    expect(result.store.lastFailure).toBe('too-large');
    expect(await result.store.save(createFixtureWorkspace())).toBe(true);
    expect(result.store.lastFailure).toBeNull();
  });

  it('tells a workspace over the size limit from a full store (localStorage)', async () => {
    const result = openLocalStorageWorkspace(empty);
    expect(await result.store.save(huge())).toBe(false);
    expect(result.store.lastFailure).toBe('too-large');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(await result.store.save(createFixtureWorkspace())).toBe(false);
    expect(result.store.lastFailure).toBe('other');
  });
});

describe('a connection that dies under the store', () => {
  it('reopens once and retries when the connection is lost', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const realCas = WorkspaceIdb.prototype.compareAndSet;
    let calls = 0;
    vi.spyOn(WorkspaceIdb.prototype, 'compareAndSet').mockImplementation(async function (this: WorkspaceIdb, ...args: Parameters<WorkspaceIdb['compareAndSet']>) {
      calls += 1;
      if (calls === 1) throw new WorkspaceIdbError('closed', 'Connection to Indexed Database server lost. Refresh the page to try again');
      return realCas.apply(this, args);
    });

    expect(await result.store.save(createFixtureWorkspace())).toBe(true);
    expect(calls).toBe(2);
    expect(result.store.lastFailure).toBeNull();
  });

  it('gives up after one reopen: the tab is told to reload, and nothing is written', async () => {
    const factory = new IDBFactory();
    const result = await track(open(factory));
    const heard = vi.fn();
    result.store.onChangedElsewhere(heard);
    vi.spyOn(WorkspaceIdb.prototype, 'compareAndSet').mockRejectedValue(new WorkspaceIdbError('closed', 'Connection to Indexed Database server lost.'));

    expect(await result.store.save(createFixtureWorkspace())).toBe(false);
    expect(result.store.lastFailure).toBe('closed');
    expect(heard).toHaveBeenCalledWith('closed');
  });
});

describe('copies kept aside in IndexedDB', () => {
  it('are only reported as kept after they were read back; otherwise the original is protected', async () => {
    const factory = new IDBFactory();
    const damaged = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"';
    await inspect(factory, (db) => db.putIfAbsent(SNAPSHOT_KEY, damaged));
    const realGet = WorkspaceIdb.prototype.get;
    // The copy is stored, but reads back as something else.
    vi.spyOn(WorkspaceIdb.prototype, 'get').mockImplementation(async function (this: WorkspaceIdb, key: string) {
      return key.startsWith(WORKSPACE_UNREADABLE_BACKUP_KEY) ? 'not the copy' : realGet.call(this, key);
    });

    const result = await track(open(factory));

    expect(result.issue).toMatchObject({ kind: 'unreadable', backedUp: false, protect: true, raw: damaged });
    expect(await result.store.save({ ...empty, activeLessonId: 'x' })).toBe(false);
  });

  it('reports an older copy at the cap without removing copies or pausing the current workspace', async () => {
    const factory = new IDBFactory();
    const migrated = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(migrated));
    const first = await track(open(factory));
    await first.store.save({ ...first.snapshot, lessons: first.snapshot.lessons.slice(0, 2) });
    first.store.dispose();
    await inspect(factory, async (db) => {
      for (let index = 0; index < 8; index += 1) await db.putAll(new Map([[index === 0 ? WORKSPACE_UNREADABLE_BACKUP_KEY : `${WORKSPACE_UNREADABLE_BACKUP_KEY}.${index}`, `copy ${index}`]]));
    });
    const olderRaw = legacyRaw({ ...migrated, lessons: migrated.lessons.slice(0, 1) });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, olderRaw);

    const second = await track(open(factory));

    expect(second.issue).toMatchObject({ kind: 'older-copy', backedUp: false, protect: false, copyLimitReached: true, raw: olderRaw });
    expect(await second.store.readCopy(second.issue!)).toBe(olderRaw);
    expect(second.snapshot.lessons).toHaveLength(2);
    expect(await second.store.save({ ...second.snapshot, activeLessonId: 'fixture-context' })).toBe(true);
    expect(JSON.parse(String(await storedSnapshot(factory))).activeLessonId).toBe('fixture-context');
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(olderRaw);
    const keys = await inspect(factory, (db) => db.keysWithPrefix(WORKSPACE_UNREADABLE_BACKUP_KEY));
    expect(keys).toHaveLength(8);
    for (let index = 0; index < 8; index += 1) {
      const key = index === 0 ? WORKSPACE_UNREADABLE_BACKUP_KEY : `${WORKSPACE_UNREADABLE_BACKUP_KEY}.${index}`;
      expect(await inspect(factory, (db) => db.get(key))).toBe(`copy ${index}`);
    }
  });
});

describe('the default load timeout', () => {
  it('is 20 seconds, and the load is abandoned exactly then', async () => {
    expect(DEFAULT_LOAD_TIMEOUT_MS).toBe(20_000);
    const factory = new IDBFactory();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyRaw(createFixtureWorkspace()));
    vi.spyOn(WorkspaceIdb.prototype, 'getSnapshotAndMeta').mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const opening = open(factory, { openTimeoutMs: 1e9 }).then((value) => { settled = true; opened.push(value); return value; });
      // Let the database open (it runs on real timers) before the clock moves.
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => (globalThis as unknown as { setImmediate: (callback: () => void) => void }).setImmediate(() => resolve(undefined)));
      await vi.advanceTimersByTimeAsync(DEFAULT_LOAD_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const result = await opening;
      expect(result.unavailable).toEqual({ reason: 'indexeddb-timeout', protect: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
