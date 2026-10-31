import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { AI_UNREACHABLE_MESSAGE } from './lib/service-errors';
import { SOURCE_REMOVAL_UNDO_MS } from './lib/source-removal';
import type { SourceBlobStore } from './lib/source-storage';
import { WORKSPACE_STORAGE_KEY, WORKSPACE_UNREADABLE_BACKUP_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

// Regression tests for the user-journey QA pass: each one reproduces a problem a real student could hit.
const savedWorkspace = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
const memoryBlobStore = (): SourceBlobStore => ({
  durability: 'memory-only',
  save: vi.fn(async () => undefined),
  load: vi.fn(async () => null),
  remove: vi.fn(async () => undefined),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const expireUndoWindow = (timers: { mock: { calls: unknown[][] } }) => {
  const call = timers.mock.calls.find((args) => args[1] === SOURCE_REMOVAL_UNDO_MS);
  expect(call).toBeDefined();
  act(() => { (call![0] as () => void)(); });
};
const RECORDING_NOTICE_STORAGE_KEY = 'studentllm.recording-notice.v1';

function seedWorkspace() {
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
  localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
}

describe('user journeys', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    seedWorkspace();
  });
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('AI offline (issue 338)', () => {
    it('shows a plain-language alert instead of a stored assistant answer, and keeps the question for a retry', async () => {
      const user = userEvent.setup();
      const generate = vi.fn()
        .mockRejectedValueOnce(new Error('Provider request failed (502)'))
        .mockResolvedValueOnce({ content: 'A recovered answer.', model: 'mock-model' });
      render(<App provider={{ generate }} />);

      await user.click(screen.getByRole('tab', { name: /Chat/ }));
      await user.type(screen.getByLabelText('Ask the course chat'), 'Explain why normalization matters.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(AI_UNREACHABLE_MESSAGE);
      expect(screen.queryByText(/502/)).not.toBeInTheDocument();
      // The failure is not an assistant answer, in the page or in the saved workspace.
      expect(screen.queryByLabelText('Course assistant response')).not.toBeInTheDocument();
      expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].chat).toEqual([]);
      // The question is back in the composer, so sending again needs no retyping and does not duplicate it.
      expect(screen.getByLabelText('Ask the course chat')).toHaveValue('Explain why normalization matters.');

      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByText('A recovered answer.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      const chat = savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].chat;
      expect(chat.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
      expect(chat.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(1);
    });

    it('does not overwrite a new draft with the failed question and clears the alert when the draft is edited', async () => {
      const user = userEvent.setup();
      render(<App provider={{ generate: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }} />);
      await user.click(screen.getByRole('tab', { name: /Chat/ }));
      const composer = screen.getByLabelText('Ask the course chat');
      await user.type(composer, 'Why does attention use a softmax?');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('not reachable');

      await user.type(composer, '!');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('explains the same failure for Study material without raw status codes', async () => {
      const user = userEvent.setup();
      render(<App provider={{ generate: vi.fn().mockRejectedValue(new Error('Provider request failed (502)')) }} />);
      await user.click(screen.getByRole('tab', { name: /Study/ }));
      await user.click(screen.getByRole('button', { name: /Flashcards/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent(AI_UNREACHABLE_MESSAGE);
      expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([]);
    });

    it('explains the same failure in the course organizer', async () => {
      const user = userEvent.setup();
      render(<App provider={{ generate: vi.fn().mockRejectedValue(new Error('Provider request failed (503)')) }} />);
      await user.click(screen.getByLabelText('Course actions'));
      await user.click(screen.getByRole('button', { name: /Organize material with AI/ }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/Lecture excerpt/), 'Gradient descent updates parameters by following the negative gradient of the loss.');
      await user.click(within(dialog).getByRole('button', { name: 'Analyze structure' }));

      await waitFor(() => expect(within(dialog).getByText(AI_UNREACHABLE_MESSAGE)).toBeInTheDocument());
    });
  });

  describe('imports that overlap with other work', () => {
    it('keeps text imported while an audio file is still being transcribed', async () => {
      const user = userEvent.setup();
      const transcription = deferred<{ model: string; segments: Array<{ id: string; timestamp: string; speaker: string; text: string; status: 'review' }> }>();
      render(<App provider={null} speechEngine={{ transcribe: () => transcription.promise }} sourceBlobStore={memoryBlobStore()} />);

      await user.upload(screen.getByLabelText('Select course source'), new File(['audio-bytes'], 'lecture.webm', { type: 'audio/webm' }));
      await screen.findByText(/Transcribing with the speech service/);
      await user.upload(screen.getByLabelText('Select course source'), new File(['Notes imported during the wait.'], 'during.md', { type: 'text/markdown' }));
      await waitFor(() => expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((segment: { text: string }) => segment.text === 'Notes imported during the wait.')).toBe(true));

      await act(async () => {
        transcription.resolve({ model: 'fixture', segments: [{ id: '1', timestamp: '00:00:01', speaker: 'Speaker', text: 'Spoken words from the recording.', status: 'review' }] });
      });
      await waitFor(() => expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((segment: { text: string }) => segment.text === 'Spoken words from the recording.')).toBe(true));

      const texts = savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.map((segment: { text: string }) => segment.text);
      expect(texts).toContain('Notes imported during the wait.');
      expect(texts).toContain('Spoken words from the recording.');
      expect(texts).toContain('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.');
    });

    it('does not resurrect a course that was deleted while its document was being extracted', async () => {
      const user = userEvent.setup();
      const extraction = deferred<{ model: string; pages: Array<{ pageNumber: number; text: string; blocks: [] }> }>();
      render(<App provider={null} documentEngine={{ extract: () => extraction.promise }} sourceBlobStore={memoryBlobStore()} />);

      await user.upload(screen.getByLabelText('Select course source'), new File(['%PDF-1.4'], 'slow.pdf', { type: 'application/pdf' }));
      await screen.findByText(/slow\.pdf added to course sources/);
      await user.click(screen.getByLabelText('Course actions'));
      await user.click(screen.getByRole('button', { name: 'Delete course' }));
      await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
      await screen.findByText('Attention & Scaled Dot-Product deleted.');

      await act(async () => {
        extraction.resolve({ model: 'pymupdf', pages: [{ pageNumber: 1, text: 'Text of the deleted course.', blocks: [] }] });
      });
      await waitFor(() => expect(JSON.stringify(savedWorkspace())).not.toContain('Text of the deleted course.'));
      expect(Object.keys(savedWorkspace().lessonWorkspaces)).not.toContain(FIXTURE_LESSON_ID);
    });

    it('refuses an empty file and a second copy of a file already in the course', async () => {
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

      await user.upload(screen.getByLabelText('Select course source'), new File([], 'empty.pdf', { type: 'application/pdf' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('empty.pdf is empty, so nothing was imported.');
      expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].resources.map((resource: { name: string }) => resource.name)).not.toContain('empty.pdf');

      const note = () => new File(['The same notes.'], 'notes.md', { type: 'text/markdown' });
      await user.upload(screen.getByLabelText('Select course source'), note());
      await screen.findByText(/notes\.md added to course sources/);
      await user.upload(screen.getByLabelText('Select course source'), note());
      expect(await screen.findByRole('alert')).toHaveTextContent('notes.md is already in this course.');
      expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].resources.filter((resource: { name: string }) => resource.name === 'notes.md')).toHaveLength(1);
    });

    it('keeps the stored original while another course still uses the same file', async () => {
      const user = userEvent.setup();
      const sourceBlobStore = memoryBlobStore();
      render(<App provider={null} sourceBlobStore={sourceBlobStore} />);
      const shared = () => new File(['Shared handout text.'], 'handout.md', { type: 'text/markdown' });

      await user.upload(screen.getByLabelText('Select course source'), shared());
      await screen.findByText(/handout\.md added to course sources/);
      await user.click(screen.getByRole('button', { name: 'Self-attention and Context' }));
      await user.upload(screen.getByLabelText('Select course source'), shared());
      await waitFor(() => expect(savedWorkspace().lessonWorkspaces['fixture-context'].resources.map((resource: { name: string }) => resource.name)).toContain('handout.md'));

      // Removing it from the second course must not erase the original the first course still points to.
      await user.click(screen.getByRole('tab', { name: /^Sources/ }));
      const timers = vi.spyOn(window, 'setTimeout');
      await user.click(screen.getByRole('button', { name: 'Remove source handout.md' }));
      expireUndoWindow(timers);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
      expect(vi.mocked(sourceBlobStore.remove).mock.calls.filter(([id]) => id.startsWith('source-'))).toHaveLength(0);

      // Deleting the first course after that is the last use, so the original goes with it.
      await user.click(screen.getByRole('button', { name: 'Attention & Scaled Dot-Product' }));
      await user.click(screen.getByLabelText('Course actions'));
      await user.click(screen.getByRole('button', { name: 'Delete course' }));
      await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
      await screen.findByText('Attention & Scaled Dot-Product deleted.');
      expect(vi.mocked(sourceBlobStore.remove).mock.calls.filter(([id]) => id.startsWith('source-'))).toHaveLength(1);
    });
  });

  describe('browser storage safety', () => {
    it('tells the student when the workspace cannot be saved instead of claiming it was', async () => {
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === WORKSPACE_STORAGE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      try {
        await user.upload(screen.getByLabelText('Select course source'), new File(['Notes that do not fit.'], 'big.md', { type: 'text/markdown' }));
        const banner = await screen.findByText(/Your changes are not being saved/);
        expect(banner.closest('[role="alert"]')).toHaveTextContent('Export course');
        expect(within(banner.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Export this course' })).toBeInTheDocument();
      } finally {
        Storage.prototype.setItem = original;
      }
      // Once storage works again the next successful save clears the banner.
      await user.upload(screen.getByLabelText('Select course source'), new File(['More notes.'], 'more.md', { type: 'text/markdown' }));
      await waitFor(() => expect(screen.queryByText(/Your changes are not being saved/)).not.toBeInTheDocument());
    });

    it('explains that a damaged workspace was replaced and that a copy was kept', async () => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, '{"version":1,"lessons":[{"id":"a","subj');
      render(<App provider={null} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
      expect(screen.getByRole('alert')).toHaveTextContent('A copy of the original data was kept');
      expect(localStorage.getItem(WORKSPACE_UNREADABLE_BACKUP_KEY)).toBe('{"version":1,"lessons":[{"id":"a","subj');
      await userEvent.setup().click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('stops saving when another tab changed the workspace, so it cannot overwrite that work', async () => {
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      const otherTabsWorkspace = JSON.stringify({ ...createFixtureWorkspace(), lessons: [] });

      act(() => {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, otherTabsWorkspace);
        window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_STORAGE_KEY, newValue: otherTabsWorkspace }));
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('changed in another tab or window');
      expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Reload' })).toBeInTheDocument();

      await user.upload(screen.getByLabelText('Select course source'), new File(['Written in the stale tab.'], 'stale.md', { type: 'text/markdown' }));
      await screen.findByText(/stale\.md added to course sources/);
      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(otherTabsWorkspace);
    });

    it('asks before closing the tab while an import is still running', async () => {
      const user = userEvent.setup();
      const extraction = deferred<{ model: string; pages: Array<{ pageNumber: number; text: string; blocks: [] }> }>();
      render(<App provider={null} documentEngine={{ extract: () => extraction.promise }} sourceBlobStore={memoryBlobStore()} />);
      const closeTab = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };

      expect(closeTab()).toBe(false);
      await user.upload(screen.getByLabelText('Select course source'), [
        new File(['%PDF-1.4 a'], 'a.pdf', { type: 'application/pdf' }),
        new File(['%PDF-1.4 b'], 'b.pdf', { type: 'application/pdf' }),
      ]);
      await waitFor(() => expect(closeTab()).toBe(true));
      await act(async () => {
        extraction.resolve({ model: 'pymupdf', pages: [{ pageNumber: 1, text: 'Page text.', blocks: [] }] });
      });
      await waitFor(() => expect(closeTab()).toBe(false));
    });
  });

  describe('recording problems', () => {
    const fakeSession = () => {
      const listeners: Array<(problem: 'interrupted' | 'storage') => void> = [];
      return {
        listeners,
        recordingId: 'journey-recording',
        stream: {} as MediaStream,
        durability: 'memory-only' as const,
        readChunks: vi.fn(async () => []),
        onProblem: (listener: (problem: 'interrupted' | 'storage') => void) => { listeners.push(listener); },
        stop: vi.fn(async () => ({ recordingId: 'journey-recording', chunksPersisted: 3, persistenceError: false })),
      };
    };

    it('ends the recording and says why when the microphone disappears', async () => {
      const user = userEvent.setup();
      const session = fakeSession();
      render(<App provider={null} speechEngine={null} recorderSessionFactory={async () => session} />);

      await user.click(screen.getByRole('button', { name: 'Start recording' }));
      await screen.findByRole('button', { name: 'Stop recording' });
      act(() => session.listeners.forEach((listener) => listener('interrupted')));

      expect(await screen.findByText(/The microphone stopped working, so recording ended/)).toBeInTheDocument();
      expect(session.stop).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled());
    });

    it('warns while recording when audio can no longer be stored, without stopping it', async () => {
      const user = userEvent.setup();
      const session = fakeSession();
      render(<App provider={null} speechEngine={null} recorderSessionFactory={async () => session} />);

      await user.click(screen.getByRole('button', { name: 'Start recording' }));
      await screen.findByRole('button', { name: 'Stop recording' });
      act(() => session.listeners.forEach((listener) => listener('storage')));

      expect(await screen.findByText(/can no longer store the audio/)).toBeInTheDocument();
      expect(session.stop).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
    });

    it('explains a blocked or missing microphone in plain language', async () => {
      const user = userEvent.setup();
      const factory = vi.fn()
        .mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
        .mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'));
      render(<App provider={null} recorderSessionFactory={factory} />);

      await user.click(screen.getByRole('button', { name: 'Start recording' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access is blocked.');
      await user.click(screen.getByRole('button', { name: 'Start recording' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No microphone was found.'));
      expect(screen.queryByText(/Permission denied|Requested device/)).not.toBeInTheDocument();
    });
  });

  describe('notes', () => {
    it('renders an imported Markdown file as formatted notes, not raw syntax', async () => {
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

      await user.upload(screen.getByLabelText('Select course source'), new File(
        [['## Dérivées', '', 'La dérivée de $x^2$ est $2x$.', '', '| a | b |', '|---|---|', '| 1 | 2 |', ''].join(String.fromCharCode(10))],
        'cours.md',
        { type: 'text/markdown' },
      ));

      const notes = await screen.findByRole('region', { name: 'Course notes document' });
      await waitFor(() => expect(within(notes).getByRole('heading', { name: 'Dérivées' })).toBeInTheDocument());
      expect(within(notes).getByRole('table')).toBeInTheDocument();
      expect(notes).not.toHaveTextContent('## Dérivées');
      expect(notes).not.toHaveTextContent('|---|');
    });

    it('keeps a plain text file as written', async () => {
      const user = userEvent.setup();
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

      await user.upload(screen.getByLabelText('Select course source'), new File([['# not a heading', 'second line'].join(String.fromCharCode(10))], 'plain.txt', { type: 'text/plain' }));
      const notes = await screen.findByRole('region', { name: 'Course notes document' });
      await waitFor(() => expect(notes).toHaveTextContent('# not a heading'));
    });
  });

  describe('files that arrive in other ways', () => {
    const dropFiles = (files: File[]) => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } });
      act(() => { window.dispatchEvent(event); });
      return event;
    };

    it('imports a file dropped on the window instead of letting the browser leave the app', async () => {
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);

      const event = dropFiles([new File(['Dropped notes.'], 'dropped.md', { type: 'text/markdown' })]);
      expect(event.defaultPrevented).toBe(true);
      expect(await screen.findByText(/dropped\.md added to course sources/)).toBeInTheDocument();
      expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].resources.map((resource: { name: string }) => resource.name)).toContain('dropped.md');
    });

    it('ignores drags that carry no files, such as selected text', () => {
      render(<App provider={null} />);
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], files: [] } });
      act(() => { window.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    });

    it('asks for a course first when nothing is open', () => {
      localStorage.clear();
      render(<App provider={null} />);
      const event = dropFiles([new File(['Notes.'], 'notes.md', { type: 'text/markdown' })]);
      expect(event.defaultPrevented).toBe(true);
      expect(screen.getByText('Create a course first, then drop the files onto it.')).toBeInTheDocument();
    });

    it('keeps a file of an unreadable type as an original and says so', async () => {
      // The file picker's own filter would normally hide such a file; "All files" or a drop still delivers it.
      const user = userEvent.setup({ applyAccept: false });
      render(<App provider={null} sourceBlobStore={memoryBlobStore()} />);
      await user.upload(screen.getByLabelText('Select course source'), new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('setup.exe was saved as an original in Sources, but StudentLLM cannot read this type of file.');
    });

    it('says why a truncated course export cannot be imported and changes nothing', async () => {
      const user = userEvent.setup();
      render(<App provider={null} />);
      const lessonsBefore = savedWorkspace().lessons.length;
      await user.upload(screen.getByLabelText('Import course export'), new File(['{"format":"studentllm-course","version":1,"lesson":{'], 'physics.studentllm.json', { type: 'application/json' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('physics.studentllm.json could not be imported. The file is damaged or cut short');
      expect(screen.getByRole('alert')).toHaveTextContent('Nothing was changed.');
      expect(savedWorkspace().lessons).toHaveLength(lessonsBefore);
    });
  });
});
