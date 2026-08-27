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
    expect(within(recent as HTMLElement).getByText('Study guide')).toBeInTheDocument();
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

    expect(await screen.findByRole('button', { name: 'Source · optimization.md' })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Source · optimization.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LM Studio · mock-local-model' })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith([
      { role: 'system', content: expect.stringContaining('Gradient descent updates parameters using the learning rate.') },
      { role: 'user', content: 'What updates parameters using the learning rate?' },
    ]);
  });

  it('records a bookmark and exposes a review segment', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this passage' }));

    expect(screen.getByText('Student bookmark: review this point in the course.')).toBeInTheDocument();
    expect(screen.getByText(/Bookmark added at/)).toBeInTheDocument();
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
