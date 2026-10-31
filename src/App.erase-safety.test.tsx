import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { PENDING_SOURCE_ERASE_STORAGE_KEY } from './lib/pending-source-erase';
import { listPendingRecordings, RECORDING_RECOVERY_STORAGE_KEY, savePendingRecording } from './lib/recording-recovery';
import { SOURCE_REMOVAL_UNDO_MS } from './lib/source-removal';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

// Regression tests for #411: an original is never erased while the workspace that lists it is not safely stored, and an
// interrupted recording is not forgotten because its course was not read.
const RECORDING_NOTICE_STORAGE_KEY = 'studentllm.recording-notice.v1';
const ledger = () => JSON.parse(localStorage.getItem(PENDING_SOURCE_ERASE_STORAGE_KEY) ?? '[]') as Array<{ id: string; kind: string }>;
const blobStore = (): SourceBlobStore => ({
  durability: 'memory-only',
  save: vi.fn(async () => undefined),
  load: vi.fn(async () => null),
  remove: vi.fn(async () => undefined),
});
const chunkStore = (count = 0) => ({
  durability: 'durable' as const,
  append: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
  count: vi.fn(async () => count),
  clear: vi.fn(async () => undefined),
});
const expireUndoWindow = (timers: { mock: { calls: unknown[][] } }) => {
  const call = timers.mock.calls.find((args) => args[1] === SOURCE_REMOVAL_UNDO_MS);
  expect(call).toBeDefined();
  act(() => { (call![0] as () => void)(); });
};
const stopSaving = () => act(() => { window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_STORAGE_KEY })); });
const failSaving = () => {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    if (key === WORKSPACE_STORAGE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return original.call(this, key, value);
  };
  return () => { Storage.prototype.setItem = original; };
};

function workspaceWithSource(): ReturnType<typeof createFixtureWorkspace> {
  const workspace = createFixtureWorkspace();
  const resource = { id: 'source-original', name: 'handout.md', meta: 'Text', kind: 'document' as const, mimeType: 'text/markdown' };
  workspace.resources = [resource];
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID] = { ...workspace.lessonWorkspaces![FIXTURE_LESSON_ID], resources: [resource] };
  return workspace;
}

async function removeHandout(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  const timers = vi.spyOn(window, 'setTimeout');
  await user.click(screen.getByRole('button', { name: 'Remove source handout.md' }));
  expireUndoWindow(timers);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
}

async function deleteFirstCourse(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Course actions'));
  await user.click(screen.getByRole('button', { name: 'Delete course' }));
  await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
  await screen.findByText(/Attention & Scaled Dot-Product deleted/);
}

describe('erasing stored originals', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceWithSource()));
    localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('erases the original of a removed source when saving is healthy (control)', async () => {
    const user = userEvent.setup();
    const sources = blobStore();
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);
    await removeHandout(user);

    await waitFor(() => expect(sources.remove).toHaveBeenCalledWith('source-original'));
    expect(ledger()).toEqual([]);
  });

  it('keeps the original, and remembers it, when a removal finishes while another tab owns the workspace', async () => {
    const user = userEvent.setup();
    const sources = blobStore();
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);
    stopSaving();
    await removeHandout(user);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sources.remove).not.toHaveBeenCalled();
    expect(ledger().map((entry) => entry.id)).toEqual(['source-original']);
  });

  it('keeps the original, and remembers it, when a removal finishes while the browser store is full', async () => {
    const user = userEvent.setup();
    const sources = blobStore();
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);
    const restore = failSaving();
    try {
      await removeHandout(user);
      await screen.findByText(/Your changes are not being saved/);
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      restore();
    }
    expect(sources.remove).not.toHaveBeenCalled();
    expect(ledger().map((entry) => entry.id)).toEqual(['source-original']);
    // The saved workspace still lists the source: after a reload it is there, and so is its file.
    expect(JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!).lessonWorkspaces[FIXTURE_LESSON_ID].resources.map((resource: { id: string }) => resource.id)).toContain('source-original');
  });

  it('erases an original that a failed removal had kept once a later start finds it unlisted', async () => {
    const sources = blobStore();
    const saved = createFixtureWorkspace();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify([{ id: 'source-original', kind: 'document' }]));
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);

    await waitFor(() => expect(sources.remove).toHaveBeenCalledWith('source-original'));
    expect(ledger()).toEqual([]);
  });

  it('keeps an original that the saved workspace still lists when the startup sweep runs', async () => {
    const sources = blobStore();
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify([{ id: 'source-original', kind: 'document' }]));
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);

    await waitFor(() => expect(ledger()).toEqual([]));
    expect(sources.remove).not.toHaveBeenCalled();
  });

  it('erases nothing at startup when the workspace could not be read, and keeps the ledger', async () => {
    const sources = blobStore();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"');
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify([{ id: 'source-original', kind: 'document' }]));
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);

    await screen.findByRole('alert');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sources.remove).not.toHaveBeenCalled();
    expect(ledger().map((entry) => entry.id)).toEqual(['source-original']);
  });

  it('erases the originals of a deleted course only once the deletion is stored', async () => {
    const user = userEvent.setup();
    const sources = blobStore();
    let storedWhenErased: string[] | null = null;
    vi.mocked(sources.remove).mockImplementation(async () => {
      storedWhenErased = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!).lessons.map((lesson: { id: string }) => lesson.id);
    });
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunkStore()} />);
    await deleteFirstCourse(user);

    expect(sources.remove).toHaveBeenCalledWith('source-original');
    // At the moment the file was erased, the stored workspace no longer listed the course.
    expect(storedWhenErased).not.toBeNull();
    expect(storedWhenErased).not.toContain(FIXTURE_LESSON_ID);
    expect(ledger()).toEqual([]);
  });

  it.each([
    ['another tab owns the workspace', () => { stopSaving(); return () => undefined; }],
    ['the browser store is full', failSaving],
  ])('keeps the originals and the interrupted recording of a course deleted while %s', async (_name, breakSaving) => {
    const user = userEvent.setup();
    const sources = blobStore();
    const chunks = chunkStore(3);
    render(<App provider={null} sourceBlobStore={sources} recordingChunkStore={chunks} />);
    await act(async () => { await Promise.resolve(); });
    // The recording was interrupted in this window (after the start-up recovery pass).
    savePendingRecording({ recordingId: 'interrupted-recording', lessonId: FIXTURE_LESSON_ID, lessonTitle: 'Attention & Scaled Dot-Product', startedAt: 1 });
    const restore = breakSaving();
    try {
      await user.click(screen.getByLabelText('Course actions'));
      await user.click(screen.getByRole('button', { name: 'Delete course' }));
      await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
      await screen.findByText(/Its files are kept until your changes can be saved/);
    } finally {
      restore();
    }

    expect(sources.remove).not.toHaveBeenCalled();
    expect(chunks.clear).not.toHaveBeenCalled();
    expect(listPendingRecordings().map((pending) => pending.recordingId)).toEqual(['interrupted-recording']);
    expect(ledger().map((entry) => entry.id)).toEqual(['source-original']);
  });
});

describe('interrupted recordings and an unreadable workspace', () => {
  const damaged = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"';
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
    localStorage.setItem(WORKSPACE_STORAGE_KEY, damaged);
    savePendingRecording({ recordingId: 'lost-course-recording', lessonId: 'lesson-that-was-not-read', lessonTitle: 'Maths', startedAt: 1 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps the manifest while the workspace has a load problem, and after the notice is dismissed', async () => {
    const user = userEvent.setup();
    const chunks = chunkStore(4);
    render(<App provider={null} sourceBlobStore={blobStore()} recordingChunkStore={chunks} />);

    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listPendingRecordings().map((pending) => pending.recordingId)).toEqual(['lost-course-recording']);
    expect(chunks.clear).not.toHaveBeenCalled();
  });

  it('keeps the manifest after "Start empty anyway" while the audio is still stored', async () => {
    const user = userEvent.setup();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('studentllm.workspace.v1.unreadable-backup')) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<App provider={null} sourceBlobStore={blobStore()} recordingChunkStore={chunkStore(4)} />);
      await user.click(await screen.findByRole('button', { name: 'Start empty anyway' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(JSON.parse(localStorage.getItem(RECORDING_RECOVERY_STORAGE_KEY)!).recordings.map((entry: { recordingId: string }) => entry.recordingId)).toEqual(['lost-course-recording']);
  });

  it('waits while the load problem is shown, and only then forgets a manifest whose audio is gone', async () => {
    const user = userEvent.setup();
    render(<App provider={null} sourceBlobStore={blobStore()} recordingChunkStore={chunkStore(0)} />);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(listPendingRecordings().map((pending) => pending.recordingId)).toEqual(['lost-course-recording']);

    await user.click(dismiss);
    await waitFor(() => expect(listPendingRecordings()).toEqual([]));
  });
});

describe('reloading from the stale-tab banner', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
    localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('does not ask a second time: the banner already said that changes made here are not saved', async () => {
    const user = userEvent.setup();
    render(<App provider={null} sourceBlobStore={blobStore()} />);
    const closeTab = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    stopSaving();
    await screen.findByRole('alert');
    // Closing the tab by hand is still confirmed: changes made here would be lost.
    expect(closeTab()).toBe(true);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(closeTab()).toBe(false);
  });
});
