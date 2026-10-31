// Where the browser keeps the workspace. The web app used to write one JSON string to localStorage (about 5 MB per
// origin). It now writes the same string to IndexedDB, falls back to localStorage where IndexedDB cannot be used, and
// reads an existing localStorage workspace once, copying it over and verifying the copy before relying on it.
//
// Safety rules that every path below keeps:
//   - the localStorage value is never deleted or modified by the migration, and stays as a fallback for at least one release;
//   - nothing is written before the load finished, and nothing is written over a value that could not be read unless a
//     copy of it was kept first (the same rule as the localStorage path);
//   - a save only goes through if no other tab saved since this tab loaded (a version counter checked inside the write
//     transaction), so two tabs can never overwrite each other, whether or not a change notification reached them.
import {
  classifyUnreadable,
  createLoadIssue,
  isBootstrapSnapshot,
  loadWorkspaceWithStatus,
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  migrateWithBackup,
  parseWorkspaceDetailed,
  readWorkspaceCopy,
  saveWorkspace,
  serializeWorkspaceSnapshot,
  WORKSPACE_MIGRATION_BACKUP_KEY,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_UNREADABLE_BACKUP_KEY,
  type KeyValueStorage,
  type WorkspaceLoadIssue,
  type WorkspaceSnapshot,
} from './workspace-storage';
import { RECORDING_RECOVERY_STORAGE_KEY } from './recording-recovery';
import { META_KEY, openWorkspaceDb, parseMeta, SNAPSHOT_KEY, WorkspaceIdbError, type CloseReason, type WorkspaceIdb } from './workspace-idb';

/** Set in localStorage once the workspace lives in IndexedDB. If IndexedDB later fails to open, this says that the localStorage copy is stale. */
export const WORKSPACE_IDB_ACTIVE_KEY = 'studentllm.workspace.v1.idb-active';
export const WORKSPACE_BROADCAST_CHANNEL = 'studentllm.workspace.v1';

export type WorkspaceBackend = 'indexeddb' | 'localstorage';
export type ChangeReason = 'saved-elsewhere' | 'conflict' | 'version-change' | 'closed' | 'storage-event';

export interface BrowserWorkspaceStore {
  readonly backend: WorkspaceBackend;
  /** Resolves with whether the snapshot is now stored. Never throws. */
  save: (snapshot: WorkspaceSnapshot) => Promise<boolean>;
  /** While protected nothing is written: the stored value was unreadable and must stay as it is. */
  setProtected: (protect: boolean) => void;
  /** Another tab or window wrote the workspace, or the storage was closed under this tab. The listener may fire once only. */
  onChangedElsewhere: (listener: (reason: ChangeReason) => void) => () => void;
  /** The stored value a load issue refers to, for a download. */
  readCopy: (issue: WorkspaceLoadIssue) => Promise<string | null>;
  dispose: () => void;
}

export interface BrowserBootstrap {
  snapshot: WorkspaceSnapshot;
  issue: WorkspaceLoadIssue | null;
  store: BrowserWorkspaceStore;
  /**
   * IndexedDB could not be used and the workspace came from localStorage. When `protect` is true IndexedDB held the
   * workspace before, so the localStorage copy is stale and saving stays paused.
   */
  unavailable?: { reason: 'indexeddb-unavailable' | 'indexeddb-blocked'; protect: boolean };
}

export interface BrowserWorkspaceDeps {
  /** `null` means there is no IndexedDB; leave it out to use the browser's. */
  indexedDb?: IDBFactory | null;
  localStorage?: Storage;
  /** `null` turns the change notifications off (the version check inside every save still protects the data). */
  broadcastChannel?: typeof BroadcastChannel | null;
  /** How long to wait for another tab to release the database. */
  openTimeoutMs?: number;
  now?: () => number;
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function getIndexedDb(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB;
  } catch {
    return undefined;
  }
}

/** Whether the browser workspace should be loaded from IndexedDB (asynchronously) rather than from localStorage. */
export function shouldUseIndexedDb(): boolean {
  return getIndexedDb() !== undefined;
}

/** A short content fingerprint (length and FNV-1a), enough to tell "the same value" from "a value someone changed". */
export function fingerprintWorkspace(raw: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${raw.length}:${hash.toString(16)}`;
}

// ---------------------------------------------------------------- localStorage backend

class LocalStorageWorkspaceStore implements BrowserWorkspaceStore {
  readonly backend = 'localstorage' as const;
  private protectedFlag: boolean;

  constructor(private readonly storage: Storage | undefined, protect = false) {
    this.protectedFlag = protect;
  }

  save(snapshot: WorkspaceSnapshot) {
    // Written synchronously, as before: a change is in storage by the time the effect that made it has run.
    return Promise.resolve(!this.protectedFlag && saveWorkspace(snapshot, this.storage));
  }

  setProtected(protect: boolean) {
    this.protectedFlag = protect;
  }

  onChangedElsewhere(listener: (reason: ChangeReason) => void) {
    if (typeof window === 'undefined') return () => undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== WORKSPACE_STORAGE_KEY) return;
      listener('storage-event');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  readCopy(issue: WorkspaceLoadIssue) {
    return Promise.resolve(readWorkspaceCopy(issue, this.storage));
  }

  dispose() {
    // Nothing is held open.
  }
}

/** The synchronous path: the workspace is read from localStorage before the first render. */
export function openLocalStorageWorkspace(fallback: WorkspaceSnapshot, storage: Storage | undefined = getLocalStorage()): BrowserBootstrap {
  const { snapshot, issue } = loadWorkspaceWithStatus(fallback, storage);
  return { snapshot, issue, store: new LocalStorageWorkspaceStore(storage, Boolean(issue?.protect)) };
}

// ---------------------------------------------------------------- aside copies

/**
 * The copy and backup helpers were written against the synchronous `Storage` API. This shim lets them run unchanged
 * against IndexedDB: it starts from the copies already stored, records what they would write, and the caller then
 * stores those writes in IndexedDB and reads them back before claiming a copy was kept.
 */
class AsideShim implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  readonly pending = new Map<string, string>();

  constructor(private readonly local: Storage | undefined) {}

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    // The interrupted-recording manifest lives in localStorage and decides whether the demo workspace may be migrated.
    if (key === RECORDING_RECOVERY_STORAGE_KEY) return this.local?.getItem(key) ?? null;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
    this.pending.set(key, value);
  }

  async load(db: WorkspaceIdb) {
    const keys = [
      ...await db.keysWithPrefix(WORKSPACE_UNREADABLE_BACKUP_KEY),
      ...await db.keysWithPrefix(WORKSPACE_MIGRATION_BACKUP_KEY),
    ];
    for (const key of keys) {
      const value = await db.get(key);
      if (typeof value === 'string') this.values.set(key, value);
    }
  }
}

async function storeAndVerify(db: WorkspaceIdb, entries: ReadonlyMap<string, string>): Promise<boolean> {
  if (!entries.size) return true;
  try {
    await db.putAll(entries);
    for (const [key, value] of entries) if (await db.get(key) !== value) return false;
    return true;
  } catch {
    return false;
  }
}

interface Interpreted {
  snapshot: WorkspaceSnapshot;
  issue: WorkspaceLoadIssue | null;
  /** The demo-workspace cleanup changed the snapshot; the caller saves it right away, as the localStorage path does. */
  migrated: boolean;
}

/** What the localStorage loader does with a stored string, with the copies going to IndexedDB. */
async function interpret(db: WorkspaceIdb, local: Storage | undefined, raw: string | null, fallback: WorkspaceSnapshot): Promise<Interpreted> {
  const { snapshot: parsed, dropped } = parseWorkspaceDetailed(raw, fallback);
  const run = (shim: AsideShim): Interpreted => {
    if (parsed === fallback) {
      // `raw` is empty on a first launch; anything else that failed to parse is data the user had.
      const issue = raw && !isBootstrapSnapshot(raw) ? createLoadIssue(raw, classifyUnreadable(raw), shim) : null;
      return { snapshot: fallback, issue, migrated: false };
    }
    const issue = dropped > 0 && raw ? createLoadIssue(raw, 'partial', shim) : null;
    const snapshot = migrateWithBackup(raw, parsed, shim);
    return { snapshot, issue, migrated: snapshot !== parsed };
  };

  let shim = new AsideShim(local);
  let result = run(shim);
  if (!shim.pending.size) return result;

  // Something has to be copied aside. Run again against the copies already stored, so identical ones are reused.
  shim = new AsideShim(local);
  await shim.load(db);
  result = run(shim);
  if (!await storeAndVerify(db, shim.pending)) {
    // The copy could not be kept. Say so: the original must then stay where it is and saving stays paused.
    return {
      snapshot: result.migrated ? parsed : result.snapshot,
      issue: result.issue && raw ? { kind: result.issue.kind, backedUp: false, raw, protect: true } : result.issue,
      migrated: false,
    };
  }
  return { ...result, issue: result.issue?.copyKey ? { ...result.issue, copyStore: 'indexeddb' } : result.issue };
}

// ---------------------------------------------------------------- IndexedDB backend

interface LoadedFromIdb extends Interpreted {
  version: number;
  /** The text equal to what is stored, when the loaded snapshot reproduces it, so an unchanged state is not written again. */
  clean: boolean;
}

function readRaw(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function markIdbActive(local: Storage | undefined) {
  try {
    if (local && local.getItem(WORKSPACE_IDB_ACTIVE_KEY) !== '1') local.setItem(WORKSPACE_IDB_ACTIVE_KEY, '1');
  } catch {
    // Without the flag a failed open later falls back to localStorage instead of pausing; the data itself is safe.
  }
}

async function readMetaVersion(db: WorkspaceIdb) {
  try {
    return parseMeta(await db.get(META_KEY))?.version ?? 0;
  } catch {
    return 0;
  }
}

/** Copies the localStorage workspace into IndexedDB, reads the copy back, and only then records that it was migrated. */
async function migrateFromLocalStorage(db: WorkspaceIdb, local: Storage | undefined, lsRaw: string, now: () => number): Promise<'migrated' | 'raced'> {
  // Written only if the key is still empty: another tab may have migrated and already saved newer work.
  if (!await db.putIfAbsent(SNAPSHOT_KEY, lsRaw)) return 'raced';
  let verified = false;
  try {
    verified = await db.get(SNAPSHOT_KEY) === lsRaw;
  } finally {
    if (!verified) {
      // Our own, unverified copy: remove it so it can never be mistaken for the real workspace. localStorage is untouched.
      await db.remove(SNAPSHOT_KEY).catch(() => undefined);
    }
  }
  if (!verified) throw new WorkspaceIdbError('failed', 'The copy of the workspace in IndexedDB does not match the original.');
  try {
    await db.updateMeta((current) => ({
      ...current,
      version: current?.version ?? 1,
      migrated: { from: 'localStorage', at: now(), bytes: lsRaw.length, fingerprint: fingerprintWorkspace(lsRaw) },
    }));
  } catch {
    // The copy is verified; the marker is retried at the next start.
  }
  markIdbActive(local);
  return 'migrated';
}

async function loadFromIdb(db: WorkspaceIdb, local: Storage | undefined, fallback: WorkspaceSnapshot, now: () => number): Promise<LoadedFromIdb> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await db.get(SNAPSHOT_KEY);
    const lsRaw = readRaw(local, WORKSPACE_STORAGE_KEY);

    if (stored === undefined) {
      if (lsRaw === null) {
        // First launch: nothing stored anywhere.
        return { ...await interpret(db, local, null, fallback), version: await readMetaVersion(db), clean: false };
      }
      if (parseWorkspaceDetailed(lsRaw, fallback).snapshot !== fallback) {
        if (await migrateFromLocalStorage(db, local, lsRaw, now) === 'raced') continue;
      } else {
        // Unreadable, newer-format or bootstrap data is not copied across: IndexedDB stays empty and the localStorage
        // value stays where it is. It is handled as usual (a copy aside, an alert, saving paused when needed).
        return { ...await interpret(db, local, lsRaw, fallback), version: await readMetaVersion(db), clean: false };
      }
      const interpreted = await interpret(db, local, lsRaw, fallback);
      return { ...interpreted, version: await readMetaVersion(db), clean: !interpreted.issue && !interpreted.migrated };
    }

    const raw = typeof stored === 'string' ? stored : describeNonString(stored);
    const meta = parseMeta(await db.get(META_KEY));
    // IndexedDB holds the workspace, so a localStorage copy can only be older from here on.
    markIdbActive(local);
    let interpreted = await interpret(db, local, raw, fallback);

    if (lsRaw !== null && lsRaw === raw && !meta?.migrated) {
      // An earlier start copied the workspace but was interrupted before it recorded the migration.
      await db.updateMeta((current) => ({
        ...current,
        version: current?.version ?? 0,
        migrated: { from: 'localStorage', at: now(), bytes: lsRaw.length, fingerprint: fingerprintWorkspace(lsRaw) },
      })).catch(() => undefined);
    }

    if (interpreted.snapshot === fallback && interpreted.issue?.kind === 'unreadable' && !interpreted.issue.protect && lsRaw !== null) {
      // The IndexedDB value is damaged but its copy aside was kept. The localStorage workspace from before the upgrade is
      // still there: show that instead of an empty workspace. The damaged value is not lost either way.
      const legacy = parseWorkspaceDetailed(lsRaw, fallback);
      if (legacy.snapshot !== fallback) {
        interpreted = { ...interpreted, snapshot: legacy.snapshot, issue: { ...interpreted.issue, restoredFromLegacy: true } };
      }
    } else if (!interpreted.issue && lsRaw !== null && lsRaw !== raw && meta?.migrated?.fingerprint !== fingerprintWorkspace(lsRaw)
      && parseWorkspaceDetailed(lsRaw, fallback).snapshot !== fallback) {
      // The localStorage value is not the one that was migrated: an older version, or a session that could not use
      // IndexedDB, wrote it since. It may hold newer work, so keep it and say so; it is not merged automatically.
      const copy = await interpretOlderCopy(db, local, lsRaw, now);
      if (copy) interpreted = { ...interpreted, issue: copy };
    }

    const clean = !interpreted.issue && !interpreted.migrated && interpreted.snapshot !== fallback;
    return { ...interpreted, version: meta?.version ?? 0, clean };
  }
  throw new WorkspaceIdbError('failed', 'The workspace database kept changing while it was being read.');
}

function describeNonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function interpretOlderCopy(db: WorkspaceIdb, local: Storage | undefined, lsRaw: string, now: () => number): Promise<WorkspaceLoadIssue | null> {
  const shim = new AsideShim(local);
  await shim.load(db);
  const issue = createLoadIssue(lsRaw, 'older-copy', shim);
  if (!issue.backedUp || !await storeAndVerify(db, shim.pending)) return null;
  // Acknowledge this exact value so the notice appears once, not at every start.
  await db.updateMeta((current) => ({
    ...current,
    version: current?.version ?? 0,
    migrated: { from: 'localStorage', at: now(), bytes: lsRaw.length, fingerprint: fingerprintWorkspace(lsRaw) },
  })).catch(() => undefined);
  return { ...issue, copyStore: 'indexeddb' };
}

type Listener = (reason: ChangeReason) => void;

class IndexedDbWorkspaceStore implements BrowserWorkspaceStore {
  readonly backend = 'indexeddb' as const;
  private version: number;
  private stale: ChangeReason | null = null;
  private protectedFlag: boolean;
  private lastSerialized: string | null;
  private readonly listeners = new Set<Listener>();
  private channel: BroadcastChannel | undefined;
  private queued: { snapshot: WorkspaceSnapshot; waiters: Array<(saved: boolean) => void> } | null = null;
  private writing = false;

  constructor(
    private readonly db: WorkspaceIdb,
    private readonly local: Storage | undefined,
    private readonly writer: string,
    state: { version: number; protect: boolean; lastSerialized: string | null },
    channelFactory: typeof BroadcastChannel | undefined,
  ) {
    this.version = state.version;
    this.protectedFlag = state.protect;
    this.lastSerialized = state.lastSerialized;
    if (channelFactory) {
      try {
        this.channel = new channelFactory(WORKSPACE_BROADCAST_CHANNEL);
        this.channel.onmessage = (event: MessageEvent) => {
          const data = event.data as { type?: unknown; writer?: unknown } | null;
          if (data?.type === 'saved' && data.writer !== this.writer) this.markStale('saved-elsewhere');
        };
      } catch {
        // The version check inside every write still catches the other tab, at its next save.
        this.channel = undefined;
      }
    }
  }

  markStale(reason: ChangeReason) {
    if (this.stale) return;
    this.stale = reason;
    for (const listener of [...this.listeners]) listener(reason);
  }

  save(snapshot: WorkspaceSnapshot) {
    // Several saves can arrive while one write runs. Only the newest of those waiting is written; all of them get its result.
    return new Promise<boolean>((resolve) => {
      if (this.queued) {
        this.queued.snapshot = snapshot;
        this.queued.waiters.push(resolve);
      } else {
        this.queued = { snapshot, waiters: [resolve] };
      }
      void this.pump();
    });
  }

  private async pump() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queued) {
        const job = this.queued;
        this.queued = null;
        let saved = false;
        try {
          saved = await this.write(job.snapshot);
        } catch {
          saved = false;
        }
        for (const waiter of job.waiters) waiter(saved);
      }
    } finally {
      this.writing = false;
    }
  }

  private async write(snapshot: WorkspaceSnapshot): Promise<boolean> {
    if (this.protectedFlag || this.stale) return false;
    let serialized: string;
    try {
      serialized = serializeWorkspaceSnapshot(snapshot);
    } catch {
      return false;
    }
    if (serialized.length > MAX_WORKSPACE_SNAPSHOT_BYTES) return false;
    // Opening a second tab saves the same state it just loaded. That must not look like a change to the first tab.
    if (serialized === this.lastSerialized) return true;
    try {
      const result = await this.db.compareAndSet(this.version, serialized, this.writer);
      if (!result.ok) {
        this.markStale('conflict');
        return false;
      }
      this.version = result.version;
      this.lastSerialized = serialized;
      markIdbActive(this.local);
      try {
        this.channel?.postMessage({ type: 'saved', writer: this.writer, version: result.version });
      } catch {
        // Other tabs find out at their next save.
      }
      return true;
    } catch (error) {
      // A full store (QuotaExceededError) or a blocked one: the caller shows the "not being saved" alert and the Export button.
      if (error instanceof WorkspaceIdbError && error.code === 'closed') this.markStale('closed');
      return false;
    }
  }

  setProtected(protect: boolean) {
    this.protectedFlag = protect;
  }

  onChangedElsewhere(listener: Listener) {
    this.listeners.add(listener);
    // The change may have been noticed while the page was still loading.
    if (this.stale) queueMicrotask(() => { if (this.listeners.has(listener)) listener(this.stale!); });
    return () => {
      this.listeners.delete(listener);
    };
  }

  async readCopy(issue: WorkspaceLoadIssue) {
    if (issue.raw !== undefined) return issue.raw;
    if (!issue.copyKey) return null;
    if (issue.copyStore === 'indexeddb') {
      try {
        const value = await this.db.get(issue.copyKey);
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    }
    return readWorkspaceCopy(issue, this.local);
  }

  dispose() {
    this.listeners.clear();
    try {
      this.channel?.close();
    } catch {
      // Already closed.
    }
    this.db.close();
  }
}

// ---------------------------------------------------------------- entry point

function newWriterId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Reads without writing anything: used when IndexedDB holds the real workspace but cannot be opened. */
function openStaleLocalStorageCopy(fallback: WorkspaceSnapshot, local: Storage | undefined): BrowserBootstrap {
  const raw = readRaw(local, WORKSPACE_STORAGE_KEY);
  const { snapshot } = parseWorkspaceDetailed(raw, fallback);
  return {
    snapshot,
    issue: null,
    store: new LocalStorageWorkspaceStore(local, true),
    unavailable: { reason: 'indexeddb-blocked', protect: true },
  };
}

function openAfterIdbFailure(error: unknown, fallback: WorkspaceSnapshot, local: Storage | undefined): BrowserBootstrap {
  console.warn(`[workspace-storage] IndexedDB unavailable: ${error instanceof Error ? error.message : String(error)}`);
  if (readRaw(local, WORKSPACE_IDB_ACTIVE_KEY) === '1') return openStaleLocalStorageCopy(fallback, local);
  // IndexedDB never held this workspace, so localStorage is still the only copy: keep working there, with its existing alerts.
  return { ...openLocalStorageWorkspace(fallback, local), unavailable: { reason: 'indexeddb-unavailable', protect: false } };
}

/**
 * Opens the browser workspace. Resolves once the workspace is fully loaded, so the app can render it without a flash of
 * an empty one and without anything writing before the load finished. Never rejects.
 */
export async function openBrowserWorkspace(fallback: WorkspaceSnapshot, deps: BrowserWorkspaceDeps = {}): Promise<BrowserBootstrap> {
  const local = deps.localStorage ?? getLocalStorage();
  const factory = deps.indexedDb === null ? undefined : deps.indexedDb ?? getIndexedDb();
  const now = deps.now ?? Date.now;
  const writer = newWriterId();
  const early: { store?: IndexedDbWorkspaceStore; closed?: CloseReason } = {};

  let db: WorkspaceIdb;
  try {
    db = await openWorkspaceDb(factory, {
      timeoutMs: deps.openTimeoutMs,
      onClose: (reason) => {
        if (early.store) early.store.markStale(reason);
        else early.closed = reason;
      },
    });
  } catch (error) {
    return openAfterIdbFailure(error, fallback, local);
  }

  let loaded: LoadedFromIdb;
  try {
    loaded = await loadFromIdb(db, local, fallback, now);
  } catch (error) {
    db.close();
    return openAfterIdbFailure(error, fallback, local);
  }

  const { snapshot, issue } = loaded;
  const store = new IndexedDbWorkspaceStore(
    db,
    local,
    writer,
    {
      version: loaded.version,
      protect: Boolean(issue?.protect),
      lastSerialized: loaded.clean ? serializeWorkspaceSnapshot(snapshot) : null,
    },
    deps.broadcastChannel === null ? undefined : deps.broadcastChannel ?? (typeof BroadcastChannel === 'undefined' ? undefined : BroadcastChannel),
  );
  early.store = store;
  if (early.closed) store.markStale(early.closed);
  // The localStorage loader saves a cleaned-up (migrated) workspace right away; so does this one, unless the data is protected.
  if (loaded.migrated && !issue?.protect) await store.save(snapshot);
  return { snapshot, issue, store };
}
