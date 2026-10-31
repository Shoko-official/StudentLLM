import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';

// #407: a folder import used to create one empty course per file up front, so a reload or crash in the middle left empty
// courses for the files that were never reached. Each course is now created when its file starts importing.
const RECORDING_NOTICE_STORAGE_KEY = 'studentllm.recording-notice.v1';
const savedTitles = () => (JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '{"lessons":[]}').lessons as Array<{ title: string }>).map((lesson) => lesson.title);
const folderFile = (name: string, text: string) => {
  const file = new File([text], name, { type: 'text/markdown' });
  Object.defineProperty(file, 'webkitRelativePath', { value: `Probability/${name}` });
  return file;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const courseButtons = () => within(screen.getByRole('navigation')).queryAllByRole('button').map((button) => button.textContent ?? '');

describe('folder import creates each course when its file starts', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function blobStoreWithGate() {
    const gates = [deferred(), deferred(), deferred()];
    let call = 0;
    const store: SourceBlobStore = {
      durability: 'memory-only',
      save: vi.fn(() => gates[Math.min(call++, gates.length - 1)].promise),
      load: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
    };
    return { store, gates };
  }

  it('does not leave empty courses for files that were not reached yet', async () => {
    const user = userEvent.setup();
    const { store, gates } = blobStoreWithGate();
    const view = render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), [
      folderFile('Chapter 1 - Events.md', 'Events can be independent.'),
      folderFile('Chapter 2 - Variables.md', 'Random variables map outcomes to numbers.'),
      folderFile('Chapter 3 - Limits.md', 'Limit theorems describe averages.'),
    ]);

    // The first file is being stored; the other two have no course yet, in the screen or in storage.
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(savedTitles()).toEqual(['Chapter 1 - Events']));
    expect(courseButtons().filter((name) => /Chapter/.test(name))).toHaveLength(1);

    // A reload at this point (the view is torn down) finds one course, not three.
    view.unmount();
    expect(savedTitles()).toEqual(['Chapter 1 - Events']);
    gates.forEach((gate) => gate.resolve());
  });

  it('creates the courses one by one, in the order of the folder, and imports each file into its own course', async () => {
    const user = userEvent.setup();
    const { store, gates } = blobStoreWithGate();
    render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), [
      folderFile('Chapter 1 - Events.md', 'Events can be independent.'),
      folderFile('Chapter 2 - Variables.md', 'Random variables map outcomes to numbers.'),
      folderFile('Chapter 3 - Limits.md', 'Limit theorems describe averages.'),
    ]);

    for (const [index, gate] of gates.entries()) {
      await waitFor(() => expect(store.save).toHaveBeenCalledTimes(index + 1));
      await act(async () => { gate.resolve(); });
    }
    await screen.findByText('3 sources imported.');

    expect(savedTitles()).toEqual(['Chapter 1 - Events', 'Chapter 2 - Variables', 'Chapter 3 - Limits']);
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
    const notes = saved.lessons.map((lesson: { id: string }) => JSON.stringify(saved.lessonWorkspaces[lesson.id].transcript));
    expect(notes[0]).toContain('Events can be independent.');
    expect(notes[1]).toContain('Random variables map outcomes to numbers.');
    expect(notes[2]).toContain('Limit theorems describe averages.');
    // The first course of the folder is the one on screen.
    expect(screen.getByRole('heading', { name: 'Chapter 1 - Events', level: 1 })).toBeInTheDocument();
  });

  it('stopping after the current file adds no course for the files that are left', async () => {
    const user = userEvent.setup();
    const { store, gates } = blobStoreWithGate();
    render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), [
      folderFile('Chapter 1 - Events.md', 'Events can be independent.'),
      folderFile('Chapter 2 - Variables.md', 'Random variables map outcomes to numbers.'),
      folderFile('Chapter 3 - Limits.md', 'Limit theorems describe averages.'),
    ]);
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Stop after this file' }));
    expect(await screen.findByText('Import stopped. 2 remaining files were not added.')).toBeInTheDocument();
    await act(async () => { gates[0].resolve(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop after this file' })).not.toBeInTheDocument());

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(savedTitles()).toEqual(['Chapter 1 - Events']);
  });

  it('finishes a folder of two files', async () => {
    const user = userEvent.setup();
    const { store, gates } = blobStoreWithGate();
    render(<App provider={null} sourceBlobStore={store} />);
    await user.upload(screen.getByLabelText('Select course folder'), [
      folderFile('Chapter 1 - Events.md', 'Events can be independent.'),
      folderFile('Chapter 2 - Variables.md', 'Random variables map outcomes to numbers.'),
    ]);
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    await act(async () => { gates[0].resolve(); });
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
    await act(async () => { gates[1].resolve(); });
    await screen.findByText('2 sources imported.');
    expect(savedTitles()).toHaveLength(2);
  });

  it('puts the courses of a second folder at the top and shows its first course', async () => {
    const user = userEvent.setup();
    const store: SourceBlobStore = { durability: 'memory-only', save: vi.fn(async () => undefined), load: vi.fn(async () => null), remove: vi.fn(async () => undefined) };
    render(<App provider={null} sourceBlobStore={store} />);
    const folder = (name: string, files: string[]) => files.map((file) => {
      const item = new File([`${file} text.`], `${file}.md`, { type: 'text/markdown' });
      Object.defineProperty(item, 'webkitRelativePath', { value: `${name}/${file}.md` });
      return item;
    });
    await user.upload(screen.getByLabelText('Select course folder'), folder('First', ['Alpha one', 'Alpha two']));
    await screen.findByText('2 sources imported.');
    await user.upload(screen.getByLabelText('Select course folder'), folder('Second', ['Beta one', 'Beta two']));
    await waitFor(() => expect(savedTitles()).toHaveLength(4));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop after this file' })).not.toBeInTheDocument());

    expect(savedTitles()).toEqual(['Beta one', 'Beta two', 'Alpha one', 'Alpha two']);
    expect(screen.getByRole('heading', { name: 'Beta one', level: 1 })).toBeInTheDocument();
  });
});
