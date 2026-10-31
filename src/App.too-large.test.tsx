import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';

// The size limit of the saved workspace is lowered for this file, so that reaching it takes a few kilobytes, not 16 MB.
vi.mock('./lib/workspace-storage', async (importOriginal) => ({ ...await importOriginal<typeof import('./lib/workspace-storage')>(), MAX_WORKSPACE_SNAPSHOT_BYTES: 20_000 }));

const memoryBlobStore = (): SourceBlobStore => ({
  durability: 'memory-only',
  save: vi.fn(async () => undefined),
  load: vi.fn(async () => null),
  remove: vi.fn(async () => undefined),
});

// (The localStorage store checks the size inside workspace-storage, where the lowered limit does not reach; its store-level test covers it.)
describe('a workspace over the size limit (IndexedDB)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    // Other workers use unrelated fake databases; this cap test does not exercise cross-tab notifications.
    vi.stubGlobal('BroadcastChannel', undefined);
    Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true, writable: true });
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is reported as over the limit, not as a full browser, with Export', async () => {
    const user = userEvent.setup();
    render(<App provider={null} sourceBlobStore={memoryBlobStore()} recordingChunkStore={{ durability: 'memory-only', append: vi.fn(async () => undefined), list: vi.fn(async () => []), count: vi.fn(async () => 0), clear: vi.fn(async () => undefined) }} />);
    await screen.findAllByText('Attention & Scaled Dot-Product');
    await user.upload(screen.getByLabelText('Select course source'), new File(['x'.repeat(30_000)], 'enormous.md', { type: 'text/markdown' }));

    const banner = (await screen.findByText(/larger than the 16 MB limit/)).closest('[role="alert"]') as HTMLElement;
    expect(banner).toHaveTextContent('your browser still has room');
    expect(banner).not.toHaveTextContent('full or blocked');
    expect(within(banner).getByRole('button', { name: 'Export this course' })).toBeInTheDocument();
  });
});
