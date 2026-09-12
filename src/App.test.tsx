import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { listPendingRecordings, RECORDING_RECOVERY_STORAGE_KEY, savePendingRecording } from './lib/recording-recovery';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

const transcriptPreview = () => within(screen.getByRole('region', { name: 'Transcript preview' }));
type User = ReturnType<typeof userEvent.setup>;

async function openTranscript(user: User) {
  await user.click(screen.getByRole('tab', { name: 'Notes' }));
  const summary = await screen.findByText(/^Transcript \(/, { selector: 'summary' });
  if (!summary.closest('details')?.open) await user.click(summary);
}

async function openCourseActions(user: User) {
  const summary = screen.getByLabelText('Course actions');
  if (!summary.closest('details')?.open) await user.click(summary);
}

const openSources = (user: User) => user.click(screen.getByRole('tab', { name: /^Sources/ }));
const savedWorkspace = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);

function bookmarkRecorder() {
  return {
    recordingId: 'fixture-bookmark-recording',
    stream: {} as MediaStream,
    durability: 'memory-only' as const,
    readChunks: vi.fn(async () => []),
    stop: vi.fn(async () => ({ recordingId: 'fixture-bookmark-recording', chunksPersisted: 0, persistenceError: false })),
  };
}

describe('StudentLLM workspace', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
  });
  afterEach(() => {
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('renders fixture notes, sources and Study actions in the course tabs', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getAllByText('Attention & Scaled Dot-Product').length).toBeGreaterThan(0);
    expect(screen.getByRole('complementary', { name: 'Course navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Course Studio' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Course notes document' })).toHaveTextContent('The square-root factor');
    expect(screen.getByRole('region', { name: 'Transcript preview' })).not.toBeVisible();
    await openSources(user);
    expect(screen.getByText('transcript.txt')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    expect(screen.getByRole('button', { name: /Targeted quiz/ })).toBeInTheDocument();
  });

  it('renders the workspace sidebar with compact real navigation groups', () => {
    render(<App />);

    const sidebar = screen.getByRole('complementary', { name: 'Course navigation' });
    expect(sidebar).toHaveClass('workspace-sidebar');
    expect(within(sidebar).getByText('StudentLLM')).toBeInTheDocument();
    expect(within(sidebar).getByText('Workspace')).toBeInTheDocument();
    expect(within(sidebar).getByText('Courses')).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Quick start' })).toHaveClass('sidebar-row');
    expect(within(sidebar).getByRole('button', { name: 'New course' })).toHaveClass('sidebar-row');
    expect(within(sidebar).getByRole('button', { name: 'Global search' })).toHaveClass('sidebar-row');
    expect(within(sidebar).getByLabelText('Import course export').closest('.sidebar-row')).not.toBeNull();
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

    await openCourseActions(user);
    await user.click(screen.getByRole('button', { name: /Needs review/ }));

    expect(screen.getByRole('dialog', { name: /Needs review/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Without this normalization/ })).toBeInTheDocument();
    expect(screen.getByText('Attention & Scaled Dot-Product · 01:15:02')).toBeInTheDocument();
  });

  it('opens the complete transcript and updates review state from it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await openTranscript(user);
    await user.click(screen.getByRole('button', { name: 'View all' }));
    const transcriptDialog = screen.getByRole('dialog', { name: 'Full transcript 3' });
    expect(within(transcriptDialog).getByText('Without this normalization, dot products grow with the key dimension.')).toBeInTheDocument();

    await user.click(within(transcriptDialog).getByRole('button', { name: 'Mark segment 01:15:02 verified' }));
    expect(within(transcriptDialog).getByRole('button', { name: 'Mark segment 01:15:02 for review' })).toBeInTheDocument();
  });

  it('creates a summary from the Study tab using provider content', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({ content: 'Attention combines normalized scores with values.', model: 'fixture-model' });
    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('tab', { name: 'Study' }));
    await user.click(screen.getByRole('button', { name: /Quick summary/ }));

    expect(await screen.findByText('Attention combines normalized scores with values.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open artifact Quick summary' })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('applies transcript display preferences from Settings immediately', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(settingsDialog).getByRole('checkbox', { name: /Show verified transcript segments/ }));

    await user.click(within(settingsDialog).getByRole('button', { name: 'Done' }));
    await openTranscript(user);
    expect(transcriptPreview().queryByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).not.toBeInTheDocument();
    expect(transcriptPreview().getByText('Without this normalization, dot products grow with the key dimension.')).toBeInTheDocument();
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
    await user.click(within(reloadedSettings).getByRole('button', { name: 'Done' }));
    await openTranscript(user);
    expect(screen.getByRole('region', { name: 'Transcript preview' })).toHaveClass('compact');
    expect(transcriptPreview().queryByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).not.toBeInTheDocument();
  });

  it('traps focus inside dialogs and restores the trigger after closing', async () => {
    const user = userEvent.setup();
    render(<App />);

    const settingsButton = screen.getByRole('button', { name: /Settings/ });
    await user.click(settingsButton);
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    const closeButton = within(settingsDialog).getByRole('button', { name: 'Close settings' });
    expect(closeButton).toHaveFocus();

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(within(settingsDialog).getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(settingsButton).toHaveFocus());
  });

  it('changes the active course from the navigation tree', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Matrices and Linear Maps/ }));

    expect(screen.getAllByRole('heading', { name: 'Matrices and Linear Maps' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Course notes document' })).toHaveTextContent('A linear map preserves addition and scalar multiplication.');
    expect(screen.getByRole('button', { name: 'Matrices and Linear Maps' })).toHaveAttribute('aria-current', 'page');
  });

  it('creates a new course from the keyboard-accessible modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /New course/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Course title'), 'Distributed Systems');
    await user.click(screen.getByRole('button', { name: 'Create course' }));

    expect(screen.getAllByRole('heading', { name: 'Distributed Systems' }).length).toBeGreaterThan(0);
    expect(screen.getByText('New course created. Ready to record.')).toBeInTheDocument();
  });

  it('saves a generated study guide and restores its content after remounting', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({ content: 'Review scaling, softmax, and weighted values.', model: 'fixture-model' });
    const firstRender = render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('tab', { name: 'Study' }));
    await user.click(screen.getByRole('button', { name: /Study guide/ }));

    expect(await screen.findByText('Review scaling, softmax, and weighted values.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open artifact Study guide' })).toBeInTheDocument();
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([
      expect.objectContaining({ kind: 'guide', content: 'Review scaling, softmax, and weighted values.' }),
    ]);
    firstRender.unmount();
    render(<App provider={null} />);
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    await user.click(screen.getByRole('button', { name: 'Open artifact Study guide' }));
    expect(screen.getByText('Review scaling, softmax, and weighted values.')).toBeInTheDocument();
  });

  it('saves provider artifact content with source citations', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({ content: 'A source-grounded quiz.', model: 'mock-local-model' });

    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('tab', { name: 'Study' }));
    await user.click(screen.getByRole('button', { name: /Targeted quiz/ }));

    expect(await screen.findByText('A source-grounded quiz.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transcript · 01:13:42' })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith([
      { role: 'system', content: expect.stringContaining('Create a targeted quiz') },
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

  it('opens an imported source from a chat citation', async () => {
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

    const citation = await screen.findByRole('button', { name: 'Source · optimization.md · part 1' });
    await user.click(citation);

    expect(await screen.findByRole('heading', { name: 'optimization.md' })).toBeInTheDocument();
    expect(await screen.findByText('Gradient descent updates parameters using the learning rate.')).toBeInTheDocument();
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
    expect(screen.getByText('LM Studio · mock-local-model')).toBeInTheDocument();
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
    const user = userEvent.setup();
    const session = bookmarkRecorder();
    render(<App recorderSessionFactory={async () => session} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Bookmark this passage' }));
    await openTranscript(user);

    expect(transcriptPreview().getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();
    expect(screen.getByText(/Bookmark added at/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it('toggles a transcript segment between review and verified', async () => {
    const user = userEvent.setup();

    render(<App />);

    await openTranscript(user);
    await user.click(screen.getByRole('button', { name: 'Mark segment 01:15:02 verified' }));

    const segment = transcriptPreview().getByText('Without this normalization, dot products grow with the key dimension.').closest('article');
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

    await openSources(user);
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

    await openTranscript(user);
    expect(await within(screen.getByRole('region', { name: 'Transcript preview' })).findByText('The local transcript.')).toBeInTheDocument();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob));
    expect(await screen.findByText('Local transcription added 1 segments.')).toBeInTheDocument();

    await openSources(user);
    await user.click(screen.getByRole('button', { name: 'Remove source Attention & Scaled Dot-Product audio.webm' }));
    await openTranscript(user);
    expect(transcriptPreview().queryByText('The local transcript.')).not.toBeInTheDocument();
  });

  it('routes a finalized recording to the existing course selected by LM Studio', async () => {
    const user = userEvent.setup();
    const session = {
      recordingId: 'recording-routing-test',
      stream: {} as MediaStream,
      durability: 'durable' as const,
      readChunks: vi.fn(async () => [{
        recordingId: 'recording-routing-test',
        sequence: 0,
        blob: new Blob(['audio'], { type: 'audio/webm' }),
        recordedAt: 123,
      }]),
      stop: vi.fn(async () => ({ recordingId: 'recording-routing-test', chunksPersisted: 1, persistenceError: false })),
    };
    const transcribe = vi.fn(async () => ({
      model: 'faster-whisper-small',
      segments: [{ id: 'routing-segment', timestamp: '00:00:01', speaker: 'Professor', text: 'Matrices and linear maps preserve structure.', status: 'review' as const }],
    }));
    const generate = vi.fn(async () => ({
      model: 'fixture-model',
      content: JSON.stringify({
        placement: 'existing', targetCourseId: 'fixture-linear-algebra', course: 'Mathematics',
        lesson: 'Linear Algebra', sublesson: 'Matrices and Linear Maps', subject: 'Mathematics',
        confidence: 0.94, rationale: 'The transcript describes linear maps.',
      }),
    }));

    render(<App recorderSessionFactory={async () => session} speechEngine={{ transcribe }} provider={{ generate }} />);
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));

    expect(await screen.findByText('Local transcription added and routed to Matrices and Linear Maps.')).toBeInTheDocument();
    const saved = savedWorkspace();
    expect(saved.lessonWorkspaces['fixture-attention'].resources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'recording-routing-test' }),
    ]));
    expect(saved.lessonWorkspaces['fixture-linear-algebra'].resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'recording-routing-test' }),
    ]));
    expect(saved.lessonWorkspaces['fixture-linear-algebra'].transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'recording-routing-test:routing-segment' }),
    ]));
    expect(generate).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled());
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
      segments: [{ id: 'live-asr-1', timestamp: '00:00:01', speaker: 'Speaker', text: 'Live lecture preview. $E = mc^2$', status: 'review' as const }],
    }));

    render(<App recorderSessionFactory={async () => session} speechEngine={{ transcribe }} />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await openTranscript(user);
    await waitFor(() => expect(screen.getAllByText('Live preview').length).toBeGreaterThan(0));
    const liveRegion = screen.getByRole('region', { name: 'Live course transcription' });
    expect(within(liveRegion).getByText('Live lecture preview.', { exact: false })).toBeInTheDocument();
    const courseNote = screen.getByRole('region', { name: 'Course notes document' });
    expect(screen.getByRole('heading', { name: 'Attention & Scaled Dot-Product', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Machine Learning / Transformers')).toBeInTheDocument();
    expect(courseNote).toHaveTextContent('E = mc^2');
    expect(within(liveRegion).getByRole('img', { name: 'LaTeX formula: E = mc^2' })).toBeInTheDocument();
    expect(within(courseNote).getByRole('img', { name: 'LaTeX formula: E = mc^2' })).toBeInTheDocument();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob));

    await user.click(screen.getByRole('button', { name: 'View all' }));
    const transcriptDialog = screen.getByRole('dialog', { name: 'Full transcript 3' });
    expect(within(transcriptDialog).getByText('Live lecture preview.', { exact: false })).toBeInTheDocument();
    expect(within(transcriptDialog).getAllByText('Live preview')).toHaveLength(2);
    await user.click(within(transcriptDialog).getByRole('button', { name: 'Close full transcript' }));

    await user.click(screen.getByRole('button', { name: 'Stop recording' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled());
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
    await user.click(screen.getByRole('button', { name: 'Create course' }));
    firstRender.unmount();

    render(<App />);

    expect(screen.getAllByRole('heading', { name: 'Persistent course' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('New course created. Ready to record.')).not.toBeInTheDocument();
  });

  it('keeps new-course transcript changes isolated from the existing course', async () => {
    const user = userEvent.setup();
    render(<App recorderSessionFactory={async () => bookmarkRecorder()} />);

    await user.click(screen.getByRole('button', { name: /New course/ }));
    await user.type(screen.getByLabelText('Course title'), 'Isolated course');
    await user.click(screen.getByRole('button', { name: 'Create course' }));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Bookmark this passage' }));
    await openTranscript(user);
    expect(transcriptPreview().getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled());

    await user.click(screen.getAllByRole('button', { name: /Attention & Scaled Dot-Product/ }).at(-1)!);
    await openTranscript(user);
    expect(transcriptPreview().queryByText('Student bookmark: review this point in the course.')).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Isolated course/ }).at(-1)!);
    await openTranscript(user);
    expect(transcriptPreview().getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();
  });

  it('imports a local source and restores its fingerprint after remounting', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    const file = new File(['course notes'], 'week-1.md', { type: 'text/markdown', lastModified: 123 });

    await user.upload(screen.getByLabelText('Select course source'), file);
    await openSources(user);
    expect(await screen.findByText('week-1.md')).toBeInTheDocument();
    firstRender.unmount();

    render(<App />);

    await openSources(user);
    expect(screen.getByText('week-1.md')).toBeInTheDocument();
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].resources[0]).toMatchObject({ name: 'week-1.md', lastModified: 123, sizeBytes: 12, sha256: expect.any(String) });
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

    await openTranscript(user);
    expect(await transcriptPreview().findByText('Gradient descent updates parameters.')).toBeInTheDocument();
    expect(transcriptPreview().getByText('The learning rate controls the step size.')).toBeInTheDocument();
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

    await openTranscript(user);
    expect(await transcriptPreview().findByText('A photographed formula.')).toBeInTheDocument();
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
    await openSources(user);
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

    await openTranscript(user);
    expect(await transcriptPreview().findByText('Imported lecture audio.')).toBeInTheDocument();
    await openSources(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove source imported-lecture.webm' })).toBeEnabled());
    expect(transcribe).toHaveBeenCalledWith(expect.any(File));

    await user.click(screen.getByRole('button', { name: 'Remove source imported-lecture.webm' }));

    await openTranscript(user);
    expect(transcriptPreview().queryByText('Imported lecture audio.')).not.toBeInTheDocument();
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
    await openSources(user);
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
    await openSources(user);
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
    await openTranscript(user);
    expect(await transcriptPreview().findByText('Derived page content.')).toBeInTheDocument();

    await openSources(user);
    await user.click(screen.getByRole('button', { name: 'Remove source derived.pdf' }));

    await openTranscript(user);
    expect(transcriptPreview().queryByText('Derived page content.')).not.toBeInTheDocument();
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
    await openCourseActions(user);
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
      lessonId: FIXTURE_LESSON_ID,
      lessonTitle: 'Attention & Scaled Dot-Product',
      startedAt: 100,
    });

    await openCourseActions(user);
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

  it('starts empty, creates a course, imports text into notes and persists it', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const firstRender = render(<App provider={null} />);

    expect(screen.getByRole('heading', { name: 'A place for your courses.' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('Attention & Scaled Dot-Product')).not.toBeInTheDocument();
    expect(savedWorkspace()).toMatchObject({ lessons: [], activeLessonId: '', resources: [], transcript: [], chat: [], artifacts: [] });

    await user.click(screen.getByRole('button', { name: 'Create your first course' }));
    await user.type(screen.getByLabelText('Course title'), 'Probability notes');
    await user.click(screen.getByRole('button', { name: 'Create course' }));
    expect(screen.getByRole('heading', { name: 'Your notes start here.' })).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Select course source'), new File(
      ['Independent event probabilities multiply.'], 'probability.md', { type: 'text/markdown' },
    ));
    expect(await within(screen.getByRole('region', { name: 'Course notes document' })).findByText('Independent event probabilities multiply.')).toBeInTheDocument();
    const snapshot = savedWorkspace();
    expect(snapshot.lessons).toHaveLength(1);
    expect(snapshot.lessonWorkspaces[snapshot.activeLessonId].transcript).toEqual([
      expect.objectContaining({ text: 'Independent event probabilities multiply.', sourceId: expect.any(String) }),
    ]);
    firstRender.unmount();

    render(<App provider={null} />);
    expect(screen.getByRole('heading', { name: 'Probability notes', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Course notes document' })).toHaveTextContent('Independent event probabilities multiply.');
    await openSources(user);
    expect(screen.getByRole('button', { name: /^probability\.md/ })).toBeInTheDocument();
  });

  it('uses Quick Start to classify material into an existing course after confirmation', async () => {
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({
      model: 'fixture-model',
      content: '{"placement":"existing","targetCourseId":"fixture-attention","course":"Machine Learning","lesson":"Transformers","title":"Cross-attention notes","sublesson":"Decoder context","subject":"Machine Learning","confidence":0.92,"rationale":"The excerpt refers to queries, keys and values."}',
    });
    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('button', { name: 'Quick start' }));
    const dialog = screen.getByRole('dialog', { name: 'Quick start' });
    await user.type(within(dialog).getByLabelText('Lecture excerpt or course description'), 'Cross-attention lets decoder queries read encoder keys and values.');
    await user.click(within(dialog).getByRole('button', { name: 'Analyze structure' }));

    expect(await within(dialog).findByLabelText('Title')).toHaveValue('Cross-attention notes');
    expect(within(dialog).getByLabelText('Place this material in')).toHaveValue(FIXTURE_LESSON_ID);
    await user.click(within(dialog).getByRole('button', { name: 'Apply structure' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick start' })).not.toBeInTheDocument());
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Cross-attention lets decoder queries read encoder keys and values.', sourceId: expect.stringMatching(/^quick-start-/) }),
    ]));
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ meta: 'Quick Start notes · text source', kind: 'transcript' }),
    ]));
  });

  it('uses Quick Start to create a structured course when no existing course is selected', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      version: 1, activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [], lessonWorkspaces: {},
    }));
    const user = userEvent.setup();
    const generate = vi.fn().mockResolvedValue({
      model: 'fixture-model',
      content: '{"placement":"new","targetCourseId":null,"course":"Machine Learning","lesson":"Attention","title":"Scaled dot-product notes","sublesson":"Scaled dot-product","subject":"Machine Learning","confidence":0.88,"rationale":"The text explains Q, K and V normalization."}',
    });
    render(<App provider={{ generate }} />);

    await user.click(screen.getByRole('button', { name: 'Quick start with AI' }));
    const dialog = screen.getByRole('dialog', { name: 'Quick start' });
    await user.type(within(dialog).getByLabelText('Lecture excerpt or course description'), 'Attention scales QK before applying softmax to V.');
    await user.click(within(dialog).getByRole('button', { name: 'Analyze structure' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply structure' }));

    expect(await screen.findByRole('heading', { name: 'Scaled dot-product notes', level: 1 })).toBeInTheDocument();
    expect(savedWorkspace().lessons).toEqual([expect.objectContaining({
      subject: 'Machine Learning', chapter: 'Attention', title: 'Scaled dot-product notes', sublesson: 'Scaled dot-product',
    })]);
    expect(savedWorkspace().lessonWorkspaces[savedWorkspace().activeLessonId].transcript[0]).toEqual(expect.objectContaining({
      text: 'Attention scales QK before applying softmax to V.',
    }));
  });

  it('keeps the workspace empty after deleting its last course and remounting', async () => {
    const fixture = createFixtureWorkspace();
    fixture.lessons = fixture.lessons.slice(0, 1);
    fixture.lessonWorkspaces = { [FIXTURE_LESSON_ID]: fixture.lessonWorkspaces![FIXTURE_LESSON_ID] };
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fixture));
    const user = userEvent.setup();
    const firstRender = render(<App provider={null} />);

    await openCourseActions(user);
    await user.click(screen.getByRole('button', { name: 'Delete course' }));
    await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
    expect(await screen.findByRole('heading', { name: 'A place for your courses.' })).toBeInTheDocument();
    expect(savedWorkspace()).toMatchObject({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [], lessonWorkspaces: {} });
    firstRender.unmount();

    render(<App provider={null} />);
    expect(screen.getByRole('heading', { name: 'A place for your courses.' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('Attention & Scaled Dot-Product')).not.toBeInTheDocument();
    expect(savedWorkspace().lessons).toEqual([]);
  });

  it('does not save any study material while offline', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App provider={null} />);
    await user.click(screen.getByRole('tab', { name: 'Study' }));

    for (const name of ['Quick summary', 'Study guide', 'Targeted quiz', 'Flashcards', 'Concept map', 'Glossary']) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
      expect(screen.getByRole('alert')).toHaveTextContent('Connect LM Studio in Settings to generate study material.');
      expect(screen.queryByRole('button', { name: /^Open artifact/ })).not.toBeInTheDocument();
      expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([]);
    }
    firstRender.unmount();
    render(<App provider={null} />);
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    expect(screen.queryByRole('heading', { name: 'Saved materials' })).not.toBeInTheDocument();
    expect(savedWorkspace().artifacts).toEqual([]);
  });

  it.each([
    { label: 'a provider failure', response: () => Promise.reject(new Error('Fixture provider unavailable.')), error: 'Fixture provider unavailable.' },
    { label: 'an empty provider response', response: () => Promise.resolve({ content: '   ', model: 'fixture-model' }), error: 'The model returned no study material. Try again.' },
  ])('does not save artifacts after $label', async ({ response, error }) => {
    const user = userEvent.setup();
    const generate = vi.fn(response);
    const firstRender = render(<App provider={{ generate }} />);
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    await user.click(screen.getByRole('button', { name: /Quick summary/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^Open artifact/ })).not.toBeInTheDocument();
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([]);
    expect(screen.getByRole('button', { name: /Quick summary/ })).toBeEnabled();
    firstRender.unmount();
    render(<App provider={null} />);
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    expect(screen.queryByRole('heading', { name: 'Saved materials' })).not.toBeInTheDocument();
    expect(savedWorkspace().artifacts).toEqual([]);
  });

  it('does not save an artifact until generation has succeeded', async () => {
    const user = userEvent.setup();
    let resolveGeneration!: (response: { content: string; model: string }) => void;
    const generate = vi.fn(() => new Promise<{ content: string; model: string }>((resolve) => { resolveGeneration = resolve; }));
    render(<App provider={{ generate }} />);
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    await user.click(screen.getByRole('button', { name: /Quick summary/ }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Open artifact/ })).not.toBeInTheDocument();
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([]);

    resolveGeneration({ content: 'The completed summary.', model: 'fixture-model' });
    expect(await screen.findByText('The completed summary.')).toBeInTheDocument();
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([
      expect.objectContaining({ content: 'The completed summary.' }),
    ]);
  });

  it('reports microphone unavailability without recording or adding fake content', async () => {
    const user = userEvent.setup();
    const recorderSessionFactory = vi.fn().mockRejectedValue(new Error('Microphone recording is unavailable in this browser.'));
    render(<App recorderSessionFactory={recorderSessionFactory} provider={null} />);
    const before = savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID];
    await user.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot start recording: Microphone recording is unavailable in this browser.');
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Stop recording' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo (mode|session)/)).not.toBeInTheDocument();
    expect(savedWorkspace().lessonWorkspaces[FIXTURE_LESSON_ID]).toEqual(before);
    expect(listPendingRecordings()).toEqual([]);
  });

  it.each(['Sources', 'Chat', 'Study'])('can stop a recording after switching to %s', async (tab) => {
    const user = userEvent.setup();
    const session = bookmarkRecorder();
    render(<App recorderSessionFactory={async () => session} provider={null} />);
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }));
    await user.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => expect(session.stop).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Stop recording' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  });
});
