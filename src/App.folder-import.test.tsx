import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

const saved = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '{"lessons":[]}');
const folderFile = (name: string, text: string) => {
  const file = new File([text], name, { type: 'text/markdown' });
  Object.defineProperty(file, 'webkitRelativePath', { value: `Probability/${name}` });
  return file;
};
const files = () => [
  folderFile('Chapter 1 - Events.md', 'Events can be independent.'),
  folderFile('Chapter 2 - Variables.md', 'Random variables map outcomes to numbers.'),
  folderFile('Chapter 3 - Limits.md', 'Limit theorems describe averages.'),
];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
function gatedStore() {
  const gates = [deferred(), deferred(), deferred()];
  let call = 0;
  const store: SourceBlobStore = {
    durability: 'memory-only', save: vi.fn(() => gates[Math.min(call++, gates.length - 1)].promise),
    load: vi.fn(async () => null), remove: vi.fn(async () => undefined),
  };
  return { store, gates };
}

describe('source batches stay in one selected course', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('creates one course for an entire folder in an empty workspace and preserves all sources after remount', async () => {
    const user = userEvent.setup();
    const { store, gates } = gatedStore();
    const view = render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), files());
    for (const [index, gate] of gates.entries()) {
      await waitFor(() => expect(store.save).toHaveBeenCalledTimes(index + 1));
      expect(saved().lessons).toHaveLength(1);
      await act(async () => { gate.resolve(); });
    }
    await screen.findByText('Import finished. 3 files processed.');
    await waitFor(() => expect(saved().lessons).toHaveLength(1));
    const course = saved().lessons[0];
    expect(course.title).toBe('Probability');
    expect(saved().lessonWorkspaces[course.id].resources).toHaveLength(3);
    for (const text of ['Events can be independent.', 'Random variables map outcomes to numbers.', 'Limit theorems describe averages.']) {
      expect(JSON.stringify(saved().lessonWorkspaces[course.id])).toContain(text);
    }
    view.unmount();
    render(<App provider={null} sourceBlobStore={store} />);
    expect(screen.getByRole('heading', { name: 'Probability', level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Sources/ }));
    for (const file of files()) expect(screen.getByText(file.name)).toBeInTheDocument();
  });

  it('pins an existing destination even when the user opens another course while the batch is running', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
    const initialCount = saved().lessons.length;
    const user = userEvent.setup();
    const { store, gates } = gatedStore();
    render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), files());
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Matrices and Linear Maps' }));
    for (const [index, gate] of gates.entries()) {
      await waitFor(() => expect(store.save).toHaveBeenCalledTimes(index + 1));
      await act(async () => { gate.resolve(); });
    }
    await screen.findByText('Import finished. 3 files processed.');
    const workspace = saved();
    expect(workspace.lessons).toHaveLength(initialCount);
    expect(workspace.lessonWorkspaces[FIXTURE_LESSON_ID].resources.filter((resource: { name: string }) => /Chapter/.test(resource.name))).toHaveLength(3);
    expect(workspace.lessonWorkspaces['fixture-linear-algebra'].resources).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Matrices and Linear Maps', level: 1 })).toBeInTheDocument();
  });

  it('stops after the current file without creating empty courses or importing queued files', async () => {
    const user = userEvent.setup();
    const { store, gates } = gatedStore();
    render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), files());
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Stop after this file' }));
    await act(async () => { gates[0].resolve(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop after this file' })).not.toBeInTheDocument());
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(saved().lessons).toHaveLength(1);
    expect(saved().lessonWorkspaces[saved().lessons[0].id].resources).toHaveLength(1);
  });

  it('reloads a partially completed batch with one course and only its completed source', async () => {
    const user = userEvent.setup();
    const { store, gates } = gatedStore();
    const view = render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), files());
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    await act(async () => { gates[0].resolve(); });
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
    expect(saved().lessons).toHaveLength(1);
    expect(saved().lessonWorkspaces[saved().lessons[0].id].resources).toHaveLength(1);
    view.unmount();
    render(<App provider={null} sourceBlobStore={store} />);
    expect(screen.getByRole('heading', { name: 'Probability', level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Sources/ }));
    expect(screen.getByText('Chapter 1 - Events.md')).toBeInTheDocument();
    expect(screen.queryByText('Chapter 2 - Variables.md')).not.toBeInTheDocument();
    gates.forEach((gate) => gate.resolve());
  });
});
