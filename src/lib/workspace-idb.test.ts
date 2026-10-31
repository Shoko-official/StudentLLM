import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_KEY, openWorkspaceDb, SNAPSHOT_KEY, WorkspaceIdbError, type WorkspaceIdb } from './workspace-idb';

const migrated = { from: 'localStorage' as const, at: 1, bytes: 3, fingerprint: '3:abc' };
let opened: WorkspaceIdb[] = [];
async function open(factory = new IDBFactory()) {
  const db = await openWorkspaceDb(factory);
  opened.push(db);
  return db;
}
afterEach(() => {
  for (const db of opened) db.close();
  opened = [];
  vi.restoreAllMocks();
});

describe('reading the snapshot and the metadata', () => {
  it('returns both from one instant', async () => {
    const db = await open();
    await db.compareAndSet(0, 'one', 'writer');
    expect(await db.getSnapshotAndMeta()).toMatchObject({ snapshot: 'one', meta: { version: 1, writer: 'writer' } });
  });

  it('reports an empty database as nothing', async () => {
    expect(await (await open()).getSnapshotAndMeta()).toEqual({ snapshot: undefined, meta: undefined });
  });
});

describe('removeIfEquals', () => {
  it('removes a key that still holds the value', async () => {
    const db = await open();
    await db.putIfAbsent('k', 'value');
    expect(await db.removeIfEquals('k', 'value')).toBe(true);
    expect(await db.get('k')).toBeUndefined();
  });

  it('leaves a key that holds something else, or nothing', async () => {
    const db = await open();
    await db.putIfAbsent('k', 'newer');
    expect(await db.removeIfEquals('k', 'older')).toBe(false);
    expect(await db.get('k')).toBe('newer');
    expect(await db.removeIfEquals('missing', 'x')).toBe(false);
  });
});

describe('markMigrated', () => {
  it('records the migration with the version of the snapshot it verified', async () => {
    const db = await open();
    await db.putIfAbsent(SNAPSHOT_KEY, 'copy');
    const meta = await db.markMigrated('copy', migrated);
    expect(meta).toMatchObject({ version: 1, migrated });
    expect(await db.get(META_KEY)).toMatchObject({ version: 1 });
  });

  it('refuses when the stored snapshot is no longer the verified copy', async () => {
    const db = await open();
    await db.putIfAbsent(SNAPSHOT_KEY, 'copy');
    await db.compareAndSet(0, 'newer work', 'other-tab');
    expect(await db.markMigrated('copy', migrated)).toBeNull();
    expect(await db.get(META_KEY)).not.toHaveProperty('migrated');
  });

  it('keeps the version another save already set', async () => {
    const db = await open();
    await db.compareAndSet(0, 'copy', 'other-tab');
    expect(await db.markMigrated('copy', migrated)).toMatchObject({ version: 1, migrated });
  });
});

describe('errors', () => {
  it('maps Safari\'s lost connection to a closed connection, not a full store', async () => {
    const db = await open();
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('Connection to Indexed Database server lost. Refresh the page to try again');
    });
    await expect(db.get('k')).rejects.toMatchObject({ code: 'closed' });
  });

  it('maps a quota error to quota', async () => {
    const db = await open();
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await expect(db.get('k')).rejects.toBeInstanceOf(WorkspaceIdbError);
    await expect(db.get('k')).rejects.toMatchObject({ code: 'quota' });
  });

  it('refuses work on a closed database', async () => {
    const db = await open();
    db.close();
    await expect(db.get('k')).rejects.toMatchObject({ code: 'closed' });
  });
});
