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
  saveWorkspaceResult,
  serializeWorkspaceSnapshot,
  WORKSPACE_MIGRATION_BACKUP_KEY,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_UNREADABLE_BACKUP_KEY,
  type KeyValueStorage,
  type WorkspaceLoadIssue,
  type WorkspaceSnapshot,
} from './workspace-storage';
import { RECORDING_RECOVERY_STORAGE_KEY } from './recording-recovery';
import { openWorkspaceDb, SNAPSHOT_KEY, WORKSPACE_DB_NAME, WorkspaceIdbError, type CloseReason, type WorkspaceIdb } from './workspace-idb';

/**
 * Set once the workspace lives in IndexedDB (to the date it first did). If IndexedDB later fails to open, this says that
 * the localStorage copy is stale. It is kept in localStorage and mirrored in sessionStorage, and `indexedDB.databases()`
 * is asked as well, so that one refused write does not turn a stale copy into the workspace.
 */
export const WORKSPACE_IDB_ACTIVE_KEY = 'studentllm.workspace.v1.idb-active';
export const WORKSPACE_BROADCAST_CHANNEL = 'studentllm.workspace.v1';

export type WorkspaceBackend = 'indexeddb' | 'localstorage';
export type ChangeReason = 'saved-elsewhere' | 'conflict' | 'version-change' | 'closed' | 'storage-event';
/** Why the last save did not happen. `too-large`: the workspace is over the size limit, which is not a full store. */
export type SaveFailure = 'too-large' | 'closed' | 'other';

export interface BrowserWorkspaceStore {
  readonly backend: WorkspaceBackend;
  /** Resolves with whether the snapshot is now stored. Never throws. */
  save: (snapshot: WorkspaceSnapshot) => Promise<boolean>;
  /** The reason the last save returned false; null after a save that worked. */
  readonly lastFailure: SaveFailure | null;
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
  unavailable?: { reason: 'indexeddb-unavailable' | 'indexeddb-blocked' | 'indexeddb-timeout'; protect: boolean };
}

export interface BrowserWorkspaceDeps {
  /** `null` means there is no IndexedDB; leave it out to use the browser's. */
  indexedDb?: IDBFactory | null;
  localStorage?: Storage;
  /** `null` turns the change notifications off (the version check inside every save still protects the data). */
  broadcastChannel?: typeof BroadcastChannel | null;
  /** How long to wait for another tab to release the database. */
  openTimeoutMs?: number;
  /** How long the whole load may take once the database is open before the app gives up on IndexedDB. */
  loadTimeoutMs?: number;
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

function getSessionStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** When IndexedDB first held this workspace (an ISO date, or `1` from an early build), or null if this profile does not remember it. */
function readIdbActive(local: Storage | undefined): string | null {
  return readRaw(local, WORKSPACE_IDB_ACTIVE_KEY) || readRaw(getSessionStorage(), WORKSPACE_IDB_ACTIVE_KEY) || null;
}

/** Records that IndexedDB holds the workspace. Returns whether the durable (localStorage) mark exists. */
function markIdbActive(local: Storage | undefined, now: () => number = Date.now): boolean {
  if (readRaw(local, WORKSPACE_IDB_ACTIVE_KEY)) return true;
  const stamp = new Date(now()).toISOString();
  let recorded = false;
  for (let attempt = 0; attempt < 2 && !recorded; attempt += 1) {
    try {
      local?.setItem(WORKSPACE_IDB_ACTIVE_KEY, stamp);
      recorded = Boolean(local);
    } catch {
      // A localStorage that is full refuses even this small key; try again, then rely on the other marks.
    }
  }
  // The session mark protects this browsing session, and the IndexedDB database itself is looked up when it fails to open.
  try {
    getSessionStorage()?.setItem(WORKSPACE_IDB_ACTIVE_KEY, stamp);
  } catch {
    // Best effort.
  }
  if (!recorded) console.warn('[workspace-storage] Could not record in localStorage that the workspace lives in IndexedDB.');
  return recorded;
}

function describeSince(value: string | null): string | undefined {
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** Whether IndexedDB held the workspace before: from the marks, or from the browser's list of databases. */
async function idbHeldWorkspace(local: Storage | undefined, factory: IDBFactory | undefined, askBrowser: boolean): Promise<string | null> {
  const marked = readIdbActive(local);
  if (marked) return marked;
  // Only when the database could not even be opened: after it was opened, its existence says nothing (this start may have created it).
  if (!askBrowser) return null;
  try {
    const databases = (factory as (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }) | undefined)?.databases;
    if (typeof databases === 'function') {
      const list = await Promise.race([
        databases.call(factory),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
      ]);
      if (list.some((entry) => entry.name === WORKSPACE_DB_NAME)) return '1';
    }
  } catch {
    // Unsupported or failing: the marks were the only evidence.
  }
  return null;
}

// ---------------------------------------------------------------- localStorage backend

class LocalStorageWorkspaceStore implements BrowserWorkspaceStore {
  readonly backend = 'localstorage' as const;
  lastFailure: SaveFailure | null = null;
  private protectedFlag: boolean;

  constructor(private readonly storage: Storage | undefined, protect = false) {
    this.protectedFlag = protect;
  }

  save(snapshot: WorkspaceSnapshot) {
    // Written synchronously, as before: a change is in storage by the time the effect that made it has run.
    const result = this.protectedFlag ? 'failed' : saveWorkspaceResult(snapshot, this.storage);
    this.lastFailure = result === 'saved' ? null : result === 'too-large' ? 'too-large' : 'other';
    return Promise.resolve(result === 'saved');
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
  // IndexedDB held this workspace and is not available now (no `indexedDB` at all, for instance): this copy is stale.
  if (readIdbActive(storage)) return openStaleLocalStorageCopy(fallback, storage);
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

async function readState(db: WorkspaceIdb) {
  const { snapshot, meta } = await db.getSnapshotAndMeta();
  return { stored: snapshot, meta };
}

/**
 * Copies the localStorage workspace into IndexedDB, reads the copy back, and only then records that it was migrated.
 * `raced` means another tab got there first (or the read-back was not our copy); the caller reads again. A copy is only
 * ever removed if it still is exactly the one this call wrote.
 */
async function migrateFromLocalStorage(db: WorkspaceIdb, local: Storage | undefined, lsRaw: string, now: () => number): Promise<{ status: 'raced' } | { status: 'migrated'; version: number }> {
  // Written only if the key is still empty: another tab may have migrated and already saved newer work.
  if (!await db.putIfAbsent(SNAPSHOT_KEY, lsRaw)) return { status: 'raced' };
  let verified = false;
  try {
    verified = (await db.getSnapshotAndMeta()).snapshot === lsRaw;
  } finally {
    if (!verified) await db.removeIfEquals(SNAPSHOT_KEY, lsRaw).catch(() => undefined);
  }
  if (!verified) return { status: 'raced' };
  let meta = null;
  try {
    meta = await db.markMigrated(lsRaw, { from: 'localStorage', at: now(), bytes: lsRaw.length, fingerprint: fingerprintWorkspace(lsRaw) });
  } catch {
    // The copy is verified; the marker is retried at the next start.
  }
  if (!meta) {
    // Either the marker could not be written or another tab replaced the copy: read the state again to know which.
    const again = await readState(db);
    if (again.stored !== lsRaw) return { status: 'raced' };
    meta = again.meta ?? null;
  }
  markIdbActive(local, now);
  return { status: 'migrated', version: meta?.version ?? 0 };
}

function resetIssue(since: string | null, copy: boolean): WorkspaceLoadIssue {
  return {
    kind: 'storage-reset',
    backedUp: copy,
    ...(copy ? { copyKey: WORKSPACE_STORAGE_KEY } : {}),
    ...(describeSince(since) ? { since: describeSince(since) } : {}),
    protect: false,
  };
}

async function loadFromIdb(db: WorkspaceIdb, local: Storage | undefined, fallback: WorkspaceSnapshot, now: () => number): Promise<LoadedFromIdb> {
  const wasHeld = readIdbActive(local);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The snapshot and its version are read in one transaction: another tab cannot save between the two.
    const { stored, meta } = await readState(db);
    const lsRaw = readRaw(local, WORKSPACE_STORAGE_KEY);

    if (stored === undefined) {
      if (lsRaw === null) {
        // Nothing stored anywhere. After IndexedDB held a workspace that is not a first launch: the browser cleared it.
        const first = await interpret(db, local, null, fallback);
        return { ...first, issue: wasHeld ? resetIssue(wasHeld, false) : first.issue, version: meta?.version ?? 0, clean: false };
      }
      if (parseWorkspaceDetailed(lsRaw, fallback).snapshot === fallback) {
        // Unreadable, newer-format or bootstrap data is not copied across: IndexedDB stays empty and the localStorage
        // value stays where it is. It is handled as usual (a copy aside, an alert, saving paused when needed).
        return { ...await interpret(db, local, lsRaw, fallback), version: meta?.version ?? 0, clean: false };
      }
      const migration = await migrateFromLocalStorage(db, local, lsRaw, now);
      if (migration.status === 'raced') continue;
      const interpreted = await interpret(db, local, lsRaw, fallback);
      // IndexedDB had been emptied after it held the workspace: what is shown is the older copy, and changes since are gone.
      const issue = interpreted.issue ?? (wasHeld ? resetIssue(wasHeld, true) : null);
      return { ...interpreted, issue, version: migration.version, clean: !issue && !interpreted.migrated };
    }

    const raw = typeof stored === 'string' ? stored : describeNonString(stored);
    // IndexedDB holds the workspace, so a localStorage copy can only be older from here on.
    markIdbActive(local, now);
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
  // The localStorage value itself is never touched, so it is not lost either way; the copies aside are capped.
  if (shim.length >= MAX_ASIDE_COPIES) return null;
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

const MAX_ASIDE_COPIES = 8;

type Listener = (reason: ChangeReason) => void;

class IndexedDbWorkspaceStore implements BrowserWorkspaceStore {
  readonly backend = 'indexeddb' as const;
  lastFailure: SaveFailure | null = null;
  private version: number;
  private stale: ChangeReason | null = null;
  private protectedFlag: boolean;
  private lastSerialized: string | null;
  private readonly listeners = new Set<Listener>();
  private channel: BroadcastChannel | undefined;
  private queued: { snapshot: WorkspaceSnapshot; waiters: Array<(saved: boolean) => void> } | null = null;
  private writing = false;

  constructor(
    private db: WorkspaceIdb,
    private readonly reopen: (() => Promise<WorkspaceIdb>) | undefined,
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

  private async write(snapshot: WorkspaceSnapshot, reopened = false): Promise<boolean> {
    if (this.protectedFlag || this.stale) return false;
    let serialized: string;
    try {
      serialized = serializeWorkspaceSnapshot(snapshot);
    } catch {
      this.lastFailure = 'other';
      return false;
    }
    if (serialized.length > MAX_WORKSPACE_SNAPSHOT_BYTES) {
      this.lastFailure = 'too-large';
      return false;
    }
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
      this.lastFailure = null;
      markIdbActive(this.local);
      try {
        this.channel?.postMessage({ type: 'saved', writer: this.writer, version: result.version });
      } catch {
        // Other tabs find out at their next save.
      }
      return true;
    } catch (error) {
      // A full store (QuotaExceededError) or a blocked one: the caller shows the "not being saved" alert and the Export button.
      if (error instanceof WorkspaceIdbError && error.code === 'closed') {
        // The connection died under us (Safari drops it now and then). One reopen and one retry; the version check still guards the write.
        if (!reopened && this.reopen && !this.stale) {
          try {
            this.db.close();
            this.db = await this.reopen();
            return await this.write(snapshot, true);
          } catch {
            // Could not reopen: treated as lost below.
          }
        }
        this.lastFailure = 'closed';
        this.markStale('closed');
        return false;
      }
      this.lastFailure = 'other';
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

async function openAfterIdbFailure(error: unknown, fallback: WorkspaceSnapshot, local: Storage | undefined, factory: IDBFactory | undefined, opened: boolean): Promise<BrowserBootstrap> {
  console.warn(`[workspace-storage] IndexedDB unavailable: ${error instanceof Error ? error.message : String(error)}`);
  if (await idbHeldWorkspace(local, factory, !opened)) return openStaleLocalStorageCopy(fallback, local);
  // IndexedDB never held this workspace, so localStorage is still the only copy: keep working there, with its existing alerts.
  const waited = error instanceof WorkspaceIdbError && (error.code === 'blocked' || error.code === 'timeout');
  return { ...openLocalStorageWorkspace(fallback, local), unavailable: { reason: waited ? 'indexeddb-timeout' : 'indexeddb-unavailable', protect: false } };
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new WorkspaceIdbError('timeout', 'The workspace database did not answer in time.'));
    }, ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Opens the browser workspace. Resolves once the workspace is fully loaded, so the app can render it without a flash of
 * an empty one and without anything writing before the load finished. Never rejects, and never waits forever: if
 * IndexedDB does not answer, it falls back as if it could not be opened.
 */
export async function openBrowserWorkspace(fallback: WorkspaceSnapshot, deps: BrowserWorkspaceDeps = {}): Promise<BrowserBootstrap> {
  const local = deps.localStorage ?? getLocalStorage();
  const factory = deps.indexedDb === null ? undefined : deps.indexedDb ?? getIndexedDb();
  const now = deps.now ?? Date.now;
  const writer = newWriterId();
  const early: { store?: IndexedDbWorkspaceStore; closed?: CloseReason } = {};
  const openDb = () => openWorkspaceDb(factory, {
    timeoutMs: deps.openTimeoutMs,
    onClose: (reason) => {
      if (early.store) early.store.markStale(reason);
      else early.closed = reason;
    },
  });

  let db: WorkspaceIdb;
  try {
    db = await openDb();
  } catch (error) {
    return openAfterIdbFailure(error, fallback, local, factory, false);
  }

  let opened: IndexedDbWorkspaceStore | undefined;
  try {
    return await withTimeout((async (): Promise<BrowserBootstrap> => {
      const loaded = await loadFromIdb(db, local, fallback, now);
      const { snapshot, issue } = loaded;
      const store = new IndexedDbWorkspaceStore(
        db,
        openDb,
        local,
        writer,
        {
          version: loaded.version,
          protect: Boolean(issue?.protect),
          lastSerialized: loaded.clean ? serializeWorkspaceSnapshot(snapshot) : null,
        },
        deps.broadcastChannel === null ? undefined : deps.broadcastChannel ?? (typeof BroadcastChannel === 'undefined' ? undefined : BroadcastChannel),
      );
      opened = store;
      early.store = store;
      if (early.closed) store.markStale(early.closed);
      // The localStorage loader saves a cleaned-up (migrated) workspace right away; so does this one, unless the data is protected.
      if (loaded.migrated && !issue?.protect) await store.save(snapshot);
      return { snapshot, issue, store };
    })(), deps.loadTimeoutMs ?? 20_000, () => {
      // Whatever the load was waiting for may still finish later; it must find a closed database and stop.
      if (opened) opened.dispose();
      else db.close();
    });
  } catch (error) {
    if (opened) opened.dispose();
    else db.close();
    return openAfterIdbFailure(error, fallback, local, factory, true);
  }
}
