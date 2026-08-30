import { afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { listPendingRecordings, RECORDING_RECOVERY_STORAGE_KEY, savePendingRecording } from './lib/recording-recovery';

describe('StudentLLM workspace', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  });

  it('renders the course workspace with sources and Studio actions', () => {
    render(<App />);

    expect(screen.getAllByText('Attention & Scaled Dot-Product').length).toBeGreaterThan(0);
    expect(screen.getByRole('complementary', { name: 'Course navigation' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Course Studio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Targeted quiz/ })).toBeInTheDocument();
    expect(screen.getByText('transcript.txt')).toBeInTheDocument();
  });

  it('searches indexed course content and opens the matching course', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Global search/ }));
    const searchDialog = screen.getByRole('dialog', { name: /Search all course content/ });
    await user.type(within(searchDialog).getByLabelText('Search all course content'), 'square-root factor');

    const result = await within(searchDialog).findByRole('button', { name: /square-root factor/ });
    expect(result).toHaveTextContent('Attention & Scaled Dot-Product');
    await user.click(result);
    expect(screen.queryByRole('dialog', { name: /Search all course content/ })).not.toBeInTheDocument();
  });

  it('opens a review queue with the current unresolved segments', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Needs review/ }));

    expect(screen.getByRole('dialog', { name: /Needs review/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Without this normalization/ })).toBeInTheDocument();
    expect(screen.getByText('Attention & Scaled Dot-Product · 01:15:02')).toBeInTheDocument();
  });

  it('opens the complete transcript and updates review state from it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'View all' }));
    const transcriptDialog = screen.getByRole('dialog', { name: 'Full transcript 3' });
    expect(within(transcriptDialog).getByText('Without this normalization, dot products grow with the key dimension.')).toBeInTheDocument();

    await user.click(within(transcriptDialog).getByRole('button', { name: 'Mark segment 01:15:02 verified' }));
    expect(within(transcriptDialog).getByRole('button', { name: 'Mark segment 01:15:02 for review' })).toBeInTheDocument();
  });

  it('opens the full Studio editor and creates an artifact from it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Open full Studio/ }));
    const studioDialog = screen.getByRole('dialog', { name: 'Full Studio' });
    await user.click(within(studioDialog).getByRole('button', { name: /Quick summary/ }));

    expect(within(studioDialog).getByText(/Draft quick summary for Attention & Scaled Dot-Product/)).toBeInTheDocument();
  });

  it('applies transcript display preferences from Settings immediately', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(settingsDialog).getByRole('checkbox', { name: /Show verified transcript segments/ }));

    expect(screen.queryByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).not.toBeInTheDocument();
    expect(screen.getByText('Without this normalization, dot products grow with the key dimension.')).toBeInTheDocument();
  });

  it('restores transcript display preferences from local storage', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(settingsDialog).getByRole('checkbox', { name: /Show verified transcript segments/ }));
    await user.click(within(settingsDialog).getByRole('checkbox', { name: /Compact transcript spacing/ }));
    firstRender.unmount();

    render(<App />);

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    const reloadedSettings = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(reloadedSettings).getByRole('checkbox', { name: /Show verified transcript segments/ })).not.toBeChecked();
    expect(within(reloadedSettings).getByRole('checkbox', { name: /Compact transcript spacing/ })).toBeChecked();
    expect(screen.queryByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).not.toBeInTheDocument();
  });

  it('changes the active course from the navigation tree', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Matrices and Linear Maps/ }));

    expect(screen.getAllByRole('heading', { name: 'Matrices and Linear Maps' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Camille Roux/).length).toBeGreaterThan(0);
  });

  it('creates a new course from the keyboard-accessible modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /New course/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Course title'), 'Distributed Systems');
    await user.click(screen.getByRole('button', { name: /Create and prepare/ }));

    expect(screen.getAllByRole('heading', { name: 'Distributed Systems' }).length).toBeGreaterThan(0);
    expect(screen.getByText('New course created. Ready to record.')).toBeInTheDocument();
  });

  it('adds a generated artifact to the Studio', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Study guide/ }));

    const recent = screen.getByText('Recently created').parentElement?.parentElement;
    expect(recent).toBeTruthy();
    expect(within(recent as HTMLElement).getByRole('button', { name: 'Open artifact Study guide' })).toBeInTheDocument();
    expect(await screen.findByText(/Draft study guide for Attention & Scaled Dot-Product/)).toBeInTheDocument();
  });

  it('replaces an offline artifact draft with provider content and citations', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({ content: 'A source-grounded quiz.', model: 'mock-local-model' });

    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('button', { name: /Targeted quiz/ }));

    expect(await screen.findByText('A source-grounded quiz.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transcript · 01:13:42' })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith([
      { role: 'system', content: expect.stringContaining('Create a concise targeted quiz') },
      { role: 'user', content: 'Generate the targeted quiz.' },
    ]);
  });

  it('switches to chat and sends a grounded question', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    const input = screen.getByLabelText('Ask the course chat');
    await user.type(input, 'Why do we divide by the square root of d?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('Why do we divide by the square root of d?')).toBeInTheDocument();
    expect(screen.getByText('Connect LM Studio to ask the local model. The current workspace keeps this interaction offline.')).toBeInTheDocument();
  }, 15000);

  it('uses an imported text source as an offline chat citation', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['Gradient descent updates parameters using the learning rate.'],
      'optimization.md',
      { type: 'text/markdown' },
    ));
    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    await user.type(screen.getByLabelText('Ask the course chat'), 'What updates parameters using the learning rate?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('button', { name: 'Source · optimization.md · part 1' })).toBeInTheDocument();
  }, 15000);

  it('sends retrieved source context to an injected live provider', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({ content: 'The source explains gradient descent.', model: 'mock-local-model' });
    render(<App provider={{ generate }} />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['Gradient descent updates parameters using the learning rate.'],
      'optimization.md',
      { type: 'text/markdown' },
    ));
    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    await user.type(screen.getByLabelText('Ask the course chat'), 'What updates parameters using the learning rate?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('The source explains gradient descent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source · optimization.md · part 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LM Studio · mock-local-model' })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith([
      { role: 'system', content: expect.stringContaining('Gradient descent updates parameters using the learning rate.') },
      { role: 'user', content: 'What updates parameters using the learning rate?' },
    ]);
  });

  it('renders an injected provider failure in the chat', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockRejectedValue(new Error('Provider request timed out.'));
    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    await user.type(screen.getByLabelText('Ask the course chat'), 'Explain why normalization matters.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Provider request timed out.')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('refuses an unanswerable question without calling the provider', async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    await user.type(screen.getByLabelText('Ask the course chat'), 'What is the boiling point of mercury on Mars?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('I could not find a supporting passage in the active course. Add a source or rephrase the question.')).toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
  });

  it('records a bookmark and exposes a review segment', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this passage' }));

    expect(screen.getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();
    expect(screen.getByText(/Bookmark added at/)).toBeInTheDocument();
  });

  it('toggles a transcript segment between review and verified', async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Mark segment 01:15:02 verified' }));

    const segment = screen.getByText('Without this normalization, dot products grow with the key dimension.').closest('article');
    expect(segment).toBeTruthy();
    expect(within(segment as HTMLElement).queryByText('Needs review')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark segment 01:15:02 for review' })).toBeInTheDocument();
    expect(screen.getByText('Transcript segment verified.')).toBeInTheDocument();
  });

  it('adds a durable recording resource after a successful stop', async () => {
    const user = userEvent.setup();
    const session = {
      recordingId: 'recording-resource-test',
      stream: {} as MediaStream,
      durability: 'durable' as const,
      readChunks: vi.fn(async () => [{
        recordingId: 'recording-resource-test',
        sequence: 0,
        blob: new Blob(['audio'], { type: 'audio/webm' }),
        recordedAt: 123,
      }]),
      stop: vi.fn(async () => ({
        recordingId: 'recording-resource-test',
        chunksPersisted: 2,
        persistenceError: false,
      })),
    };

    render(<App recorderSessionFactory={async () => session} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));

    expect(await screen.findByText('Attention & Scaled Dot-Product audio.webm')).toBeInTheDocument();
    expect(screen.getByText('Audio · 2 chunks')).toBeInTheDocument();
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it('does not start a durable recording when interrupted-session recovery cannot be saved', async () => {
    const user = userEvent.setup();
    const session = {
      recordingId: 'recording-recovery-failure-test',
      stream: {} as MediaStream,
      durability: 'durable' as const,
      readChunks: vi.fn(async () => []),
      stop: vi.fn(async () => ({
        recordingId: 'recording-recovery-failure-test',
        chunksPersisted: 0,
        persistenceError: false,
      })),
    };
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key === RECORDING_RECOVERY_STORAGE_KEY) throw new Error('Recovery manifest unavailable.');
      originalSetItem.call(localStorage, key, value);
    });

    render(<App recorderSessionFactory={async () => session} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Recording was not started because interrupted-session recovery is unavailable.');
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
    setItem.mockRestore();
  });

  it('adds local ASR segments after durable recording finalization', async () => {
    const user = userEvent.setup();
    const session = {
      recordingId: 'recording-asr-test',
      stream: {} as MediaStream,
      durability: 'durable' as const,
      readChunks: vi.fn(async () => [{
        recordingId: 'recording-asr-test',
        sequence: 0,
        blob: new Blob(['audio'], { type: 'audio/webm' }),
        recordedAt: 123,
      }]),
      stop: vi.fn(async () => ({
        recordingId: 'recording-asr-test',
        chunksPersisted: 1,
        persistenceError: false,
      })),
    };
    const transcribe = vi.fn(async () => ({
      model: 'faster-whisper-small',
      segments: [{ id: 'asr-1', timestamp: '00:00:01', speaker: 'Speaker', text: 'The local transcript.', status: 'review' as const }],
    }));

    render(<App recorderSessionFactory={async () => session} speechEngine={{ transcribe }} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));

    expect(await screen.findByText('The local transcript.')).toBeInTheDocument();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob));
    expect(await screen.findByText('Local transcription added 1 segments.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove source Attention & Scaled Dot-Product audio.webm' }));
    expect(screen.queryByText('The local transcript.')).not.toBeInTheDocument();
  });

  it('shows recording finalization state until audio processing completes', async () => {
    const user = userEvent.setup();
    let resolveStop!: (summary: { recordingId: string; chunksPersisted: number; persistenceError: boolean }) => void;
    const session = {
      recordingId: 'recording-finalization-test',
      stream: {} as MediaStream,
      durability: 'durable' as const,
      stop: vi.fn(() => new Promise<{ recordingId: string; chunksPersisted: number; persistenceError: boolean }>((resolve) => { resolveStop = resolve; })),
      readChunks: vi.fn(async () => []),
    };

    render(<App recorderSessionFactory={async () => session} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));

    expect(screen.getByText('Saving recording')).toBeInTheDocument();
    expect(screen.getByText('Saving audio and preparing transcript...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finishing recording' })).toBeDisabled();

    resolveStop({ recordingId: session.recordingId, chunksPersisted: 0, persistenceError: false });
    await waitFor(() => expect(screen.getByText('Session ready')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  });

  it('shows an incremental local ASR preview while recording', async () => {
    const user = userEvent.setup();
    const session = {
      recordingId: 'recording-live-preview-test',
      stream: {} as MediaStream,
      durability: 'durable' as const,
      stop: vi.fn(async () => ({
        recordingId: 'recording-live-preview-test',
        chunksPersisted: 1,
        persistenceError: false,
      })),
      readChunks: vi.fn(async () => [{
        recordingId: 'recording-live-preview-test',
        sequence: 0,
        blob: new Blob(['audio'], { type: 'audio/webm' }),
        recordedAt: 123,
      }]),
    };
    const transcribe = vi.fn(async () => ({
      model: 'faster-whisper-small',
      segments: [{ id: 'live-asr-1', timestamp: '00:00:01', speaker: 'Speaker', text: 'Live lecture preview.', status: 'review' as const }],
    }));

    render(<App recorderSessionFactory={async () => session} speechEngine={{ transcribe }} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(screen.getAllByText('Live preview').length).toBeGreaterThan(0));
    expect(screen.getByText('Live lecture preview.')).toBeInTheDocument();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob));

    await user.click(screen.getByRole('button', { name: 'Stop recording' }));
    await waitFor(() => expect(screen.getByText('Session ready')).toBeInTheDocument());
    expect(screen.queryByText('Live preview')).not.toBeInTheDocument();
  });

  it('waits for native workspace hydration before processing recording recovery', async () => {
    const loadPromise = new Promise<string>(() => undefined);
    const invoke = vi.fn((command: string) => command === 'load_workspace' ? loadPromise : Promise.resolve(null));
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke } },
    });
    localStorage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({
      version: 1,
      recordings: [{ recordingId: 'native-recording', lessonId: 'native-lesson', lessonTitle: 'Native course', startedAt: 100 }],
    }));
    const removeItem = vi.spyOn(localStorage, 'removeItem');

    render(<App />);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith('load_workspace');
    expect(removeItem).not.toHaveBeenCalledWith(RECORDING_RECOVERY_STORAGE_KEY);
  });

  it('restores a created course after remounting the workspace', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.click(screen.getByRole('button', { name: /New course/ }));
    await user.type(screen.getByLabelText('Course title'), 'Persistent course');
    await user.click(screen.getByRole('button', { name: /Create and prepare/ }));
    firstRender.unmount();

    render(<App />);

    expect(screen.getAllByRole('heading', { name: 'Persistent course' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('New course created. Ready to record.')).not.toBeInTheDocument();
  });

  it('keeps new-course transcript changes isolated from the existing course', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /New course/ }));
    await user.type(screen.getByLabelText('Course title'), 'Isolated course');
    await user.click(screen.getByRole('button', { name: /Create and prepare/ }));
    await user.click(screen.getByRole('button', { name: 'Bookmark this passage' }));
    expect(screen.getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Attention & Scaled Dot-Product/ }).at(-1)!);
    expect(screen.queryByText('Student bookmark: review this point in the course.')).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Isolated course/ }).at(-1)!);
    expect(screen.getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();
  });

  it('imports a local source and restores its fingerprint after remounting', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    const file = new File(['course notes'], 'week-1.md', { type: 'text/markdown', lastModified: 123 });

    await user.upload(screen.getByLabelText('Select course source'), file);
    expect(await screen.findByText('week-1.md')).toBeInTheDocument();
    firstRender.unmount();

    render(<App />);

    expect(screen.getByText('week-1.md')).toBeInTheDocument();
  });

  it('indexes extracted PDF pages as reviewable transcript segments', async () => {
    const user = userEvent.setup();
    const extract = vi.fn().mockResolvedValue({
      model: 'pymupdf',
      pages: [
        { pageNumber: 1, text: 'Gradient descent updates parameters.', blocks: [] },
        { pageNumber: 2, text: 'The learning rate controls the step size.', blocks: [] },
      ],
    });

    render(<App documentEngine={{ extract }} />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['%PDF-1.7'],
      'optimization.pdf',
      { type: 'application/pdf' },
    ));

    expect(await screen.findByText('Gradient descent updates parameters.')).toBeInTheDocument();
    expect(screen.getByText('The learning rate controls the step size.')).toBeInTheDocument();
    expect(screen.getByText('optimization.pdf indexed 2 pages locally.')).toBeInTheDocument();
    expect(extract).toHaveBeenCalledWith(expect.any(Blob));
  });

  it('indexes an extracted image as a reviewable transcript segment', async () => {
    const user = userEvent.setup();
    const extract = vi.fn().mockResolvedValue({
      model: 'rapidocr',
      pages: [{ pageNumber: 1, text: 'A photographed formula.', blocks: [] }],
    });

    render(<App documentEngine={{ extract }} />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['not-an-image-injected-by-the-engine'],
      'board.png',
      { type: 'image/png' },
    ));

    expect(await screen.findByText('A photographed formula.')).toBeInTheDocument();
    expect(screen.getByText('board.png indexed 1 page locally.')).toBeInTheDocument();
    expect(extract).toHaveBeenCalledWith(expect.any(Blob));
  });

  it('removes an imported source from the active course', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['temporary notes'],
      'remove-me.md',
      { type: 'text/markdown' },
    ));
    expect(await screen.findByText('remove-me.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove source remove-me.md' }));

    expect(screen.queryByText('remove-me.md')).not.toBeInTheDocument();
    expect(screen.getByText('remove-me.md removed from this course.')).toBeInTheDocument();
  });

  it('transcribes imported audio and removes its linked transcript segments', async () => {
    const user = userEvent.setup();
    const transcribe = vi.fn(async () => ({
      model: 'faster-whisper-small',
      segments: [{ id: 'imported-asr-1', timestamp: '00:00:02', speaker: 'Speaker', text: 'Imported lecture audio.', status: 'review' as const }],
    }));
    render(<App speechEngine={{ transcribe }} />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['audio bytes'],
      'imported-lecture.webm',
      { type: 'audio/webm' },
    ));

    expect(await screen.findByText('Imported lecture audio.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove source imported-lecture.webm' })).toBeEnabled());
    expect(transcribe).toHaveBeenCalledWith(expect.any(File));

    await user.click(screen.getByRole('button', { name: 'Remove source imported-lecture.webm' }));

    expect(screen.queryByText('Imported lecture audio.')).not.toBeInTheDocument();
    expect(screen.getByText('imported-lecture.webm removed from this course.')).toBeInTheDocument();
  });

  it('clears persisted chunks when removing an audio source', async () => {
    const user = userEvent.setup();
    const clear = vi.fn(async () => undefined);
    const recordingChunkStore = {
      durability: 'durable' as const,
      append: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      clear,
    };
    render(<App recordingChunkStore={recordingChunkStore} />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['audio bytes'],
      'remove-recording.webm',
      { type: 'audio/webm' },
    ));
    expect(await screen.findByText('remove-recording.webm')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove source remove-recording.webm' }));

    expect(screen.queryByText('remove-recording.webm')).not.toBeInTheDocument();
    expect(clear).toHaveBeenCalledWith(expect.any(String));
  });

  it('opens the locally stored original source in a preview', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['Notes about gradient descent.'],
      'preview-me.md',
      { type: 'text/markdown' },
    ));
    const sourceName = await screen.findByText('preview-me.md');
    const sourceButton = sourceName.closest('button');
    expect(sourceButton).not.toBeNull();
    await user.click(sourceButton!);

    const dialog = await screen.findByRole('dialog', { name: 'preview-me.md' });
    expect(dialog).toHaveTextContent('Original source');
    expect(dialog).toHaveTextContent('Notes about gradient descent.');
  });

  it('removes transcript segments derived from an imported PDF', async () => {
    const user = userEvent.setup();
    const extract = vi.fn().mockResolvedValue({
      model: 'pymupdf',
      pages: [{ pageNumber: 1, text: 'Derived page content.', blocks: [] }],
    });
    render(<App documentEngine={{ extract }} />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['%PDF-1.7'],
      'derived.pdf',
      { type: 'application/pdf' },
    ));
    expect(await screen.findByText('Derived page content.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove source derived.pdf' }));

    expect(screen.queryByText('Derived page content.')).not.toBeInTheDocument();
    expect(screen.getByText('derived.pdf removed from this course.')).toBeInTheDocument();
  });

  it('deletes the active course and switches to the next workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['course data'],
      'course-data.md',
      { type: 'text/markdown' },
    ));
    await user.click(screen.getByRole('button', { name: 'Delete course' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete Attention & Scaled Dot-Product?');
    await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));

    expect((await screen.findAllByRole('heading', { name: 'Self-attention and Context' })).length).toBeGreaterThan(0);
    expect(screen.queryByText('course-data.md')).not.toBeInTheDocument();
    expect(await screen.findByText('Attention & Scaled Dot-Product deleted.')).toBeInTheDocument();
  });

  it('deletes an interrupted-recording manifest with its course', async () => {
    const user = userEvent.setup();
    const clear = vi.fn(async () => undefined);
    const recordingChunkStore = {
      durability: 'durable' as const,
      append: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      clear,
    };
    render(<App recordingChunkStore={recordingChunkStore} />);
    await Promise.resolve();
    savePendingRecording({
      recordingId: 'orphaned-recording',
      lessonId: 'transformers-06',
      lessonTitle: 'Attention & Scaled Dot-Product',
      startedAt: 100,
    });

    await user.click(screen.getByRole('button', { name: 'Delete course' }));
    await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));

    expect(await screen.findByText('Attention & Scaled Dot-Product deleted.')).toBeInTheDocument();
    expect(clear).toHaveBeenCalledWith('orphaned-recording');
    expect(listPendingRecordings()).toEqual([]);
  });

  it('restores chat history after remounting the workspace', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    await user.type(screen.getByLabelText('Ask the course chat'), 'Persist this question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    firstRender.unmount();

    render(<App />);

    expect(screen.getByRole('tab', { name: /Chat/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    expect(screen.getByText('Persist this question')).toBeInTheDocument();
  });
});
