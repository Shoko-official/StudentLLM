import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { AI_UNREACHABLE_MESSAGE } from './lib/service-errors';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

// Regression tests for the user-journey QA pass: each one reproduces a problem a real student could hit.
const savedWorkspace = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
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
});
