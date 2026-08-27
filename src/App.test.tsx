import { beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

describe('StudentLLM workspace', () => {
  beforeEach(() => localStorage.clear());

  it('renders the course workspace with sources and Studio actions', () => {
    render(<App />);

    expect(screen.getAllByText('Attention & Scaled Dot-Product').length).toBeGreaterThan(0);
    expect(screen.getByRole('complementary', { name: 'Course navigation' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Course Studio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Targeted quiz/ })).toBeInTheDocument();
    expect(screen.getByText('transcript.txt')).toBeInTheDocument();
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
    await user.type(input, 'Can you give me an example?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('Can you give me an example?')).toBeInTheDocument();
    expect(screen.getByText('Connect LM Studio to ask the local model. The current workspace keeps this interaction offline.')).toBeInTheDocument();
  });

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
  });

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
    await user.type(screen.getByLabelText('Ask the course chat'), 'Ask the local provider to answer.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Provider request timed out.')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
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
