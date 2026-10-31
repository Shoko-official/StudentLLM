import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WorkspaceIdb } from './lib/workspace-idb';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

// With the workspace in IndexedDB, saving takes a moment: an original must not be erased before the workspace that no
// longer lists it has been stored.
const RECORDING_NOTICE_STORAGE_KEY = 'studentllm.recording-notice.v1';
const memoryBlobStore = (): SourceBlobStore => ({
  durability: 'memory-only',
  save: vi.fn(async () => undefined),
  load: vi.fn(async () => null),
  remove: vi.fn(async () => undefined),
});

describe('erasing an original while a save is in progress', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true, writable: true });
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('waits for the save in progress before it erases the original of a removed source', async () => {
    const workspace = createFixtureWorkspace();
    const resource = { id: 'source-original', name: 'handout.md', meta: 'Text', kind: 'document' as const, mimeType: 'text/markdown' };
    workspace.lessonWorkspaces![FIXTURE_LESSON_ID] = { ...workspace.lessonWorkspaces![FIXTURE_LESSON_ID], resources: [resource] };
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    const user = userEvent.setup();
    const sources = memoryBlobStore();
    render(<App provider={null} sourceBlobStore={sources} />);
    await screen.findAllByText('Attention & Scaled Dot-Product');
    await user.click(screen.getByRole('tab', { name: /^Sources/ }));

    // The write that stores the removal is slow.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realCompareAndSet = WorkspaceIdb.prototype.compareAndSet;
    vi.spyOn(WorkspaceIdb.prototype, 'compareAndSet').mockImplementation(async function (this: WorkspaceIdb, ...args: Parameters<WorkspaceIdb['compareAndSet']>) {
      await gate;
      return realCompareAndSet.apply(this, args);
    });
    const timers = vi.spyOn(window, 'setTimeout');
    await user.click(screen.getByRole('button', { name: 'Remove source handout.md' }));
    const expiry = timers.mock.calls.find((call) => call[1] === 8000);
    act(() => { (expiry![0] as () => void)(); });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sources.remove).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(sources.remove).toHaveBeenCalledWith('source-original'));
  });

  it('remembers the files of a deleted course before it stores the deletion, and erases them only afterwards', async () => {
    const workspace = createFixtureWorkspace();
    const resource = { id: 'source-original', name: 'handout.md', meta: 'Text', kind: 'document' as const, mimeType: 'text/markdown' };
    workspace.lessonWorkspaces![FIXTURE_LESSON_ID] = { ...workspace.lessonWorkspaces![FIXTURE_LESSON_ID], resources: [resource] };
    workspace.resources = [resource];
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    const user = userEvent.setup();
    const sources = memoryBlobStore();
    render(<App provider={null} sourceBlobStore={sources} />);
    await screen.findAllByText('Attention & Scaled Dot-Product');
    await waitFor(() => expect(localStorage.getItem('studentllm.workspace.v1.idb-active')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 60));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realCas = WorkspaceIdb.prototype.compareAndSet;
    vi.spyOn(WorkspaceIdb.prototype, 'compareAndSet').mockImplementation(async function (this: WorkspaceIdb, ...args: Parameters<WorkspaceIdb['compareAndSet']>) {
      await gate;
      return realCas.apply(this, args);
    });
    await user.click(screen.getByLabelText('Course actions'));
    await user.click(screen.getByRole('button', { name: 'Delete course' }));
    await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));

    // The deletion is still being written: the file is already in the ledger and has not been touched.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('studentllm.pending-source-erase.v1') ?? '[]').map((entry: { id: string }) => entry.id)).toEqual(['source-original']));
    expect(sources.remove).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(sources.remove).toHaveBeenCalledWith('source-original'));
    expect(localStorage.getItem('studentllm.pending-source-erase.v1')).toBeNull();
  });
});
