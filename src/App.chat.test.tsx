import { afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';
import type { ProviderMessage } from './lib/llm-provider';

beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('composes multiple lines with Shift+Enter and sends the complete question with Enter', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: 'Normalization keeps softmax sensitive.', model: 'fixture-model' }));
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  expect(composer.tagName).toBe('TEXTAREA');
  await user.type(composer, 'Explain attention.');
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  await user.type(composer, 'Why normalize?');
  expect(composer).toHaveValue('Explain attention.\nWhy normalize?');
  expect(generate).not.toHaveBeenCalled();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Normalization keeps softmax sensitive.')).toBeInTheDocument();
  expect(screen.getByLabelText('Your message')).toHaveTextContent('Explain attention. Why normalize?');
  expect(generate.mock.calls[0]?.[0]).toContainEqual({ role: 'user', content: 'Explain attention.\nWhy normalize?' });
  expect(composer).toHaveValue('');
});

it('does not submit Enter while an IME composition is active', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(async () => ({ content: 'A final answer.', model: 'fixture-model' }));
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  await user.type(composer, 'Explain attention.');
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: true });
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', keyCode: 229 });
  expect(composer).toHaveValue('Explain attention.');
  expect(screen.queryByLabelText('Your message')).not.toBeInTheDocument();
  expect(generate).not.toHaveBeenCalled();
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
});

it('announces a pending answer and prevents duplicate submissions', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(() => new Promise<{ content: string; model: string }>(() => {}));
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  await user.type(composer, 'Explain attention.');
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('status', { name: 'Answer in progress' })).toHaveTextContent('Preparing an answer');
  expect(composer).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(generate).toHaveBeenCalledTimes(1);
});

it('labels a cloud answer with the selected provider instead of LM Studio', async () => {
  localStorage.setItem('studentllm.services.v1', JSON.stringify({ llmProvider: 'nvidia-nim' }));
  const user = userEvent.setup();
  render(<App provider={{ generate: vi.fn(async () => ({ content: 'A cloud answer.', model: 'fixture-cloud-model' })) }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explain attention.');
  await user.keyboard('{Enter}');
  expect(await screen.findByText('NVIDIA NIM · fixture-cloud-model')).toBeInTheDocument();
});
