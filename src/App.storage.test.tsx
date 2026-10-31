import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { openBrowserWorkspace, WORKSPACE_IDB_ACTIVE_KEY } from './lib/browser-workspace-store';
import { META_KEY, openWorkspaceDb, SNAPSHOT_KEY, WorkspaceIdb } from './lib/workspace-idb';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

// The web app with IndexedDB available: the workspace opens asynchronously and is stored there.
const RECORDING_NOTICE_STORAGE_KEY = 'studentllm.recording-notice.v1';
const memoryBlobStore = (): SourceBlobStore => ({
  durability: 'memory-only',
  save: vi.fn(async () => undefined),
  load: vi.fn(async () => null),
  remove: vi.fn(async () => undefined),
});
const chunkStore = () => ({
  durability: 'memory-only' as const,
  append: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
  count: vi.fn(async () => 0),
  clear: vi.fn(async () => undefined),
});
const fixtureRaw = () => JSON.stringify(createFixtureWorkspace());
const idbValue = async (key: string) => {
  const db = await openWorkspaceDb(indexedDB);
  try {
    return await db.get(key);
  } finally {
    db.close();
  }
};
const storedActiveLesson = async () => JSON.parse(String(await idbValue(SNAPSHOT_KEY))).activeLessonId as string;
const setGlobalIndexedDb = (factory: IDBFactory | undefined) => {
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true });
};
const emptyStateHeading = () => screen.queryByRole('heading', { name: 'A place for your courses.' });

describe('the app with its workspace in IndexedDB', () => {
  let factory: IDBFactory;
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    factory = new IDBFactory();
    setGlobalIndexedDb(factory);
    localStorage.clear();
    localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('migrates a localStorage workspace, shows it, and keeps the original in localStorage', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
    const user = userEvent.setup();
    render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

    expect((await screen.findAllByText('Attention & Scaled Dot-Product')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'New course' }));
    await user.type(screen.getByLabelText('Course title'), 'Stored in IndexedDB');
    await user.click(screen.getByRole('button', { name: /^Create course/ }));

    await waitFor(async () => expect(JSON.parse(String(await idbValue(SNAPSHOT_KEY))).lessons.map((lesson: { title: string }) => lesson.title)).toContain('Stored in IndexedDB'));
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(fixtureRaw());
    expect(localStorage.getItem(WORKSPACE_IDB_ACTIVE_KEY)).toBe('1');
  });

  it('never shows an empty workspace, and writes nothing, while the stored one is loading', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realGet = WorkspaceIdb.prototype.get;
    vi.spyOn(WorkspaceIdb.prototype, 'get').mockImplementation(async function (this: WorkspaceIdb, key: string) {
      await gate;
      return realGet.call(this, key);
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');

    render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
    expect(screen.getByText('Opening your workspace...')).toBeInTheDocument();
    expect(emptyStateHeading()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New course' })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(emptyStateHeading()).not.toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
    expect(setItem.mock.calls.filter(([key]) => key === WORKSPACE_STORAGE_KEY)).toEqual([]);

    release();
    expect((await screen.findAllByText('Attention & Scaled Dot-Product')).length).toBeGreaterThan(0);
    expect(emptyStateHeading()).not.toBeInTheDocument();
  });

  it('starts with the empty-state only after a load that found nothing', async () => {
    render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
    expect(emptyStateHeading()).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'A place for your courses.' })).toBeInTheDocument();
  });

  it('keeps a damaged IndexedDB workspace untouched when no copy could be kept, and writes nothing', async () => {
    const damaged = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"';
    const db = await openWorkspaceDb(factory);
    await db.putIfAbsent(SNAPSHOT_KEY, damaged);
    db.close();
    vi.spyOn(WorkspaceIdb.prototype, 'putAll').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    const user = userEvent.setup();
    render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('saving is paused');
    await user.upload(screen.getByLabelText('Select course source'), new File(['x'], 'x.md', { type: 'text/markdown' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await idbValue(SNAPSHOT_KEY)).toBe(damaged);
  });

  it('offers the aside copy of a damaged IndexedDB workspace for download', async () => {
    const damaged = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"';
    const db = await openWorkspaceDb(factory);
    await db.putIfAbsent(SNAPSHOT_KEY, damaged);
    db.close();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => { created.push(blob); return 'blob:copy'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

    await user.click(await screen.findByRole('button', { name: 'Download saved copy' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(await created[0].text()).toBe(damaged);
  });

  describe('a full store', () => {
    it('shows the not-being-saved alert with the Export button, and clears it once space is back', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');

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
      await user.upload(screen.getByLabelText('Select course source'), new File(['Notes that do not fit.'], 'big.md', { type: 'text/markdown' }));
      const banner = (await screen.findByText(/Your changes are not being saved/)).closest('[role="alert"]') as HTMLElement;
      expect(within(banner).getByRole('button', { name: 'Export this course' })).toBeInTheDocument();
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);

      full = false;
      await user.upload(screen.getByLabelText('Select course source'), new File(['More notes.'], 'more.md', { type: 'text/markdown' }));
      await waitFor(() => expect(screen.queryByText(/Your changes are not being saved/)).not.toBeInTheDocument());
    });
  });

  describe('two tabs', () => {
    it('tells the first tab when a second one saves, and keeps the second one\'s work', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');
      await waitFor(async () => expect(await idbValue(SNAPSHOT_KEY)).toBeDefined());

      // Another tab opens the same workspace and saves a change.
      const other = await openBrowserWorkspace({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] });
      expect(await other.store.save({ ...other.snapshot, activeLessonId: 'fixture-context' })).toBe(true);

      expect(await screen.findByText(/changed in another tab or window/)).toBeInTheDocument();
      expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
      expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Export this course' })).toBeInTheDocument();

      await user.upload(screen.getByLabelText('Select course source'), new File(['Written in the stale tab.'], 'stale.md', { type: 'text/markdown' }));
      await screen.findByText(/stale\.md added to course sources/);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await storedActiveLesson()).toBe('fixture-context');
      const stored = JSON.parse(String(await idbValue(SNAPSHOT_KEY)));
      expect(JSON.stringify(stored)).not.toContain('stale.md');
      other.store.dispose();
    });

    it('does not bother the first tab when a second one only opens the workspace', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');
      await waitFor(async () => expect(await idbValue(META_KEY)).toBeDefined());

      const other = await openBrowserWorkspace({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] });
      await other.store.save(other.snapshot);
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      other.store.dispose();
    });
  });

  describe('when IndexedDB cannot be opened', () => {
    it('works from localStorage and says so, in a window that never had IndexedDB data', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      setGlobalIndexedDb({ open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory);
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} recordingChunkStore={chunkStore()} />);

      expect((await screen.findAllByText('Attention & Scaled Dot-Product')).length).toBeGreaterThan(0);
      expect(screen.getByRole('alert')).toHaveTextContent('smaller fallback');
      await user.click(screen.getByRole('button', { name: 'New course' }));
      await user.type(screen.getByLabelText('Course title'), 'Saved to the fallback');
      await user.click(screen.getByRole('button', { name: /^Create course/ }));
      await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!).lessons.map((lesson: { title: string }) => lesson.title)).toContain('Saved to the fallback'));
    });

    it('keeps the existing quota alert on the fallback path', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      setGlobalIndexedDb({ open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory);
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} recordingChunkStore={chunkStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === WORKSPACE_STORAGE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      try {
        await user.upload(screen.getByLabelText('Select course source'), new File(['Notes that do not fit.'], 'big.md', { type: 'text/markdown' }));
        expect(await screen.findByText(/Your changes are not being saved/)).toBeInTheDocument();
      } finally {
        Storage.prototype.setItem = original;
      }
    });

    it('pauses saving and shows the older copy when IndexedDB held the workspace before', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      localStorage.setItem(WORKSPACE_IDB_ACTIVE_KEY, '1');
      setGlobalIndexedDb({ open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory);
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} recordingChunkStore={chunkStore()} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('Saving is paused');
      await user.upload(screen.getByLabelText('Select course source'), new File(['Not kept.'], 'not-kept.md', { type: 'text/markdown' }));
      await screen.findByText(/not-kept\.md added to course sources/);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(fixtureRaw());
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('Settings storage line', () => {
    const withEstimate = (usage: number, quota: number, persisted = false) => {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage, quota }), persisted: async () => persisted, persist: vi.fn(async () => true) },
      });
    };
    afterEach(() => {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
    });

    it('shows how much of the browser storage is used, without a warning below 80%', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      withEstimate(300 * 1024 * 1024, 1024 * 1024 * 1024);
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');
      await user.click(screen.getByRole('button', { name: 'Settings' }));

      const panel = await screen.findByRole('group', { name: 'Browser storage' });
      expect(await within(panel).findByText(/300 MB used of about 1.0 GB/)).toBeInTheDocument();
      expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('warns at 80% and offers to ask the browser to keep the data', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      withEstimate(850 * 1024 * 1024, 1024 * 1024 * 1024);
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');
      await user.click(screen.getByRole('button', { name: 'Settings' }));

      const panel = await screen.findByRole('group', { name: 'Browser storage' });
      expect(await within(panel).findByRole('alert')).toHaveTextContent('almost full');
      const ask = await within(panel).findByRole('button', { name: 'Ask the browser to keep my data' });
      await user.click(ask);
      await within(panel).findByText(/promised to keep your data/);
    });

    it('asks the browser to keep the data once a course exists', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
      withEstimate(1, 1000);
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await screen.findAllByText('Attention & Scaled Dot-Product');
      await waitFor(() => expect((navigator.storage as unknown as { persist: ReturnType<typeof vi.fn> }).persist).toHaveBeenCalledTimes(1));
    });
  });

  it('keeps the compact snapshot across a reload of the app', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, fixtureRaw());
    const user = userEvent.setup();
    const first = render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
    await screen.findAllByText('Attention & Scaled Dot-Product');
    await user.upload(screen.getByLabelText('Select course source'), new File(['Independent event probabilities multiply.'], 'probability.md', { type: 'text/markdown' }));
    await screen.findByText(/probability\.md added to course sources/);
    await waitFor(async () => expect(JSON.stringify(JSON.parse(String(await idbValue(SNAPSHOT_KEY))).lessonWorkspaces)).toContain('Independent event probabilities multiply.'));
    first.unmount();

    render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
    expect(await screen.findByText('Independent event probabilities multiply.')).toBeInTheDocument();
    expect(JSON.parse(String(await idbValue(SNAPSHOT_KEY)))).not.toHaveProperty('transcript');
    expect(FIXTURE_LESSON_ID).toBeTruthy();
    await act(async () => undefined);
  });
});
