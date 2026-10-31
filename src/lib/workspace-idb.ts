// Low-level IndexedDB access for the browser workspace. One database, one object store of string keys:
//   - the workspace snapshot (a JSON string, the same text localStorage used to hold);
//   - a small metadata record with a version counter, used as a compare-and-swap guard between tabs;
//   - aside copies of unreadable or pre-migration workspaces.
// Nothing here knows what a workspace is. Every function either resolves or rejects with a WorkspaceIdbError.

export const WORKSPACE_DB_NAME = 'studentllm-workspace';
export const WORKSPACE_DB_VERSION = 1;
const STORE_NAME = 'kv';

export type WorkspaceIdbErrorCode =
  /** IndexedDB cannot be used at all here (blocked, private mode, no factory). */
  | 'unavailable'
  /** Another tab holds an older connection open and did not release it in time. */
  | 'blocked'
  /** The browser refused the write for lack of space. */
  | 'quota'
  /** The connection was closed under us (database deleted, upgraded elsewhere, browser data cleared). */
  | 'closed'
  /** A request or the whole load did not finish in time. */
  | 'timeout'
  | 'failed';

export class WorkspaceIdbError extends Error {
  constructor(readonly code: WorkspaceIdbErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'WorkspaceIdbError';
  }
}

export function isQuotaError(error: unknown): boolean {
  if (error instanceof WorkspaceIdbError) return error.code === 'quota';
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  return name === 'QuotaExceededError' || code === 22 || (typeof message === 'string' && /quota/i.test(message));
}

function toError(error: unknown, fallback: string): WorkspaceIdbError {
  if (error instanceof WorkspaceIdbError) return error;
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  const message = error instanceof Error && error.message ? error.message : fallback;
  if (isQuotaError(error)) return new WorkspaceIdbError('quota', message, error);
  // Safari reports a dead connection as "Connection to Indexed Database server lost".
  if (name === 'InvalidStateError' || name === 'TransactionInactiveError' || /connection to indexed database server lost/i.test(message)) return new WorkspaceIdbError('closed', message, error);
  return new WorkspaceIdbError('failed', message, error);
}

export type CloseReason = 'version-change' | 'closed';

export interface OpenOptions {
  /** How long to wait for other tabs to release an older connection before giving up. */
  timeoutMs?: number;
  /** The connection was closed by the browser, by another tab's upgrade, or by deleting the database. */
  onClose?: (reason: CloseReason) => void;
}

export interface WorkspaceMeta {
  /** Bumped by every successful save; a save only goes through if it still holds the value it loaded. */
  version: number;
  writer?: string;
  at?: number;
  /** Set once the localStorage workspace was copied here and the copy was read back and found identical. */
  migrated?: { from: 'localStorage'; at: number; bytes: number; fingerprint: string };
}

export function parseMeta(value: unknown): WorkspaceMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { version, writer, at, migrated } = value as Record<string, unknown>;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return undefined;
  const parsedMigrated = typeof migrated === 'object' && migrated !== null
    && (migrated as { from?: unknown }).from === 'localStorage'
    && typeof (migrated as { at?: unknown }).at === 'number'
    && typeof (migrated as { bytes?: unknown }).bytes === 'number'
    && typeof (migrated as { fingerprint?: unknown }).fingerprint === 'string'
    ? migrated as NonNullable<WorkspaceMeta['migrated']>
    : undefined;
  return {
    version,
    ...(typeof writer === 'string' ? { writer } : {}),
    ...(typeof at === 'number' ? { at } : {}),
    ...(parsedMigrated ? { migrated: parsedMigrated } : {}),
  };
}

export const SNAPSHOT_KEY = 'studentllm.workspace.v1';
export const META_KEY = 'studentllm.workspace.v1.meta';

export type CompareAndSetResult = { ok: true; version: number } | { ok: false; reason: 'conflict'; found: number };

export class WorkspaceIdb {
  private closed = false;

  constructor(private readonly database: IDBDatabase) {}

  get isClosed() {
    return this.closed;
  }

  close() {
    this.closed = true;
    try {
      this.database.close();
    } catch {
      // Already closed.
    }
  }

  /**
   * Runs one transaction. `work` queues requests; the promise settles when the transaction commits or aborts. Request
   * callbacks go through `guard`, so an exception inside one (a transaction that was aborted under it, a value that
   * cannot be cloned) aborts the transaction and rejects instead of surfacing as an unhandled error.
   */
  private run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, finish: (value: T) => void, guard: (handler: () => void) => () => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new WorkspaceIdbError('closed', 'The workspace database is closed.'));
        return;
      }
      let transaction: IDBTransaction;
      let result: T;
      let hasResult = false;
      try {
        transaction = this.database.transaction(STORE_NAME, mode);
      } catch (error) {
        reject(toError(error, 'Unable to start a workspace database transaction.'));
        return;
      }
      transaction.oncomplete = () => (hasResult ? resolve(result) : reject(new WorkspaceIdbError('failed', 'The transaction ended without a result.')));
      transaction.onabort = () => reject(toError(transaction.error, 'The workspace database transaction was aborted.'));
      transaction.onerror = () => undefined; // onabort follows and carries the error.
      const guard = (handler: () => void) => () => {
        try {
          handler();
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // Already finished.
          }
          // The abort event carries the browser's own reason (for instance a full disk) and settles the promise first. This
          // only makes sure it settles at all.
          setTimeout(() => reject(toError(error, 'The workspace database request failed.')), 50);
        }
      };
      try {
        work(transaction.objectStore(STORE_NAME), (value) => {
          result = value;
          hasResult = true;
        }, guard);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // Already finished.
        }
        reject(toError(error, 'The workspace database request failed.'));
      }
    });
  }

  get(key: string): Promise<unknown> {
    return this.run<unknown>('readonly', (store, finish, guard) => {
      const request = store.get(key);
      request.onsuccess = guard(() => finish(request.result));
    });
  }

  /** The snapshot and the metadata as they were at one instant: another tab cannot save between the two reads. */
  getSnapshotAndMeta(): Promise<{ snapshot: unknown; meta: WorkspaceMeta | undefined }> {
    return this.run<{ snapshot: unknown; meta: WorkspaceMeta | undefined }>('readonly', (store, finish, guard) => {
      const snapshot = store.get(SNAPSHOT_KEY);
      const meta = store.get(META_KEY);
      meta.onsuccess = guard(() => finish({ snapshot: snapshot.result, meta: parseMeta(meta.result) }));
    });
  }

  keysWithPrefix(prefix: string): Promise<string[]> {
    return this.run<string[]>('readonly', (store, finish, guard) => {
      const request = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff)));
      request.onsuccess = guard(() => finish(request.result.filter((key): key is string => typeof key === 'string')));
    });
  }

  /** Writes only when the key does not exist yet. Resolves with whether it wrote. */
  putIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.run<boolean>('readwrite', (store, finish, guard) => {
      const read = store.get(key);
      read.onsuccess = guard(() => {
        if (read.result !== undefined) {
          finish(false);
          return;
        }
        store.put(value, key);
        finish(true);
      });
    });
  }

  /** Writes several keys in one transaction; either all are stored or none is. */
  putAll(entries: ReadonlyMap<string, unknown>): Promise<void> {
    return this.run<void>('readwrite', (store, finish) => {
      for (const [key, value] of entries) store.put(value, key);
      finish(undefined);
    });
  }

  /** Deletes `key` only if it still holds exactly `value`: it never removes what another tab stored in the meantime. */
  removeIfEquals(key: string, value: unknown): Promise<boolean> {
    return this.run<boolean>('readwrite', (store, finish, guard) => {
      const read = store.get(key);
      read.onsuccess = guard(() => {
        if (read.result !== value) {
          finish(false);
          return;
        }
        store.delete(key);
        finish(true);
      });
    });
  }

  /**
   * Records the migration, but only while the stored snapshot is still the copy that was verified. Resolves with the
   * metadata (and so the version that goes with that snapshot), or null when another tab changed the snapshot first.
   */
  markMigrated(snapshot: string, migrated: NonNullable<WorkspaceMeta['migrated']>): Promise<WorkspaceMeta | null> {
    return this.run<WorkspaceMeta | null>('readwrite', (store, finish, guard) => {
      const stored = store.get(SNAPSHOT_KEY);
      const read = store.get(META_KEY);
      read.onsuccess = guard(() => {
        if (stored.result !== snapshot) {
          finish(null);
          return;
        }
        const current = parseMeta(read.result);
        const next: WorkspaceMeta = { ...current, version: current?.version ?? 1, migrated };
        store.put(next, META_KEY);
        finish(next);
      });
    });
  }

  remove(key: string): Promise<void> {
    return this.run<void>('readwrite', (store, finish) => {
      store.delete(key);
      finish(undefined);
    });
  }

  /** Reads the metadata, lets `update` change it, and writes the result, in one transaction. */
  updateMeta(update: (current: WorkspaceMeta | undefined) => WorkspaceMeta): Promise<WorkspaceMeta> {
    return this.run<WorkspaceMeta>('readwrite', (store, finish, guard) => {
      const read = store.get(META_KEY);
      read.onsuccess = guard(() => {
        const next = update(parseMeta(read.result));
        store.put(next, META_KEY);
        finish(next);
      });
    });
  }

  /**
   * Stores `snapshot` only if no other tab saved since `expectedVersion` was read. The snapshot and the new version are
   * written in the same transaction, so a conflict leaves both untouched and a crash never leaves them out of step.
   */
  compareAndSet(expectedVersion: number, snapshot: string, writer: string, now = Date.now()): Promise<CompareAndSetResult> {
    return this.run<CompareAndSetResult>('readwrite', (store, finish, guard) => {
      const read = store.get(META_KEY);
      read.onsuccess = guard(() => {
        const current = parseMeta(read.result);
        const found = current?.version ?? 0;
        if (found !== expectedVersion) {
          finish({ ok: false, reason: 'conflict', found });
          return;
        }
        const next: WorkspaceMeta = { ...current, version: found + 1, writer, at: now };
        store.put(snapshot, SNAPSHOT_KEY);
        store.put(next, META_KEY);
        finish({ ok: true, version: next.version });
      });
    });
  }
}

export function openWorkspaceDb(factory: IDBFactory | undefined, options: OpenOptions = {}): Promise<WorkspaceIdb> {
  const { timeoutMs = 10_000, onClose } = options;
  return new Promise<WorkspaceIdb>((resolve, reject) => {
    if (!factory) {
      reject(new WorkspaceIdbError('unavailable', 'IndexedDB is not available in this browser.'));
      return;
    }
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION);
    } catch (error) {
      reject(new WorkspaceIdbError('unavailable', error instanceof Error ? error.message : 'IndexedDB cannot be opened.', error));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new WorkspaceIdbError('blocked', 'Another StudentLLM tab is holding the workspace database open.'));
    }, timeoutMs);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        // We gave up waiting; do not leave a connection open that would block the next upgrade too.
        database.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      // An upgrade or a delete from another tab waits for every connection to close. Closing here keeps that tab from hanging.
      database.onversionchange = () => {
        database.close();
        onClose?.('version-change');
      };
      database.onclose = () => onClose?.('closed');
      resolve(new WorkspaceIdb(database));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WorkspaceIdbError('unavailable', request.error?.message || 'IndexedDB cannot be opened.', request.error));
    };
    // `blocked` is not final: the open goes through as soon as the other tab closes its connection. The timer bounds the wait.
    request.onblocked = () => undefined;
  });
}
