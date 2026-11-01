import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';
import type { ProviderMessage } from './lib/llm-provider';

beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('asks the provider for relevant supported visuals and saves its response as an interactive lesson', async () => {
  const user = userEvent.setup();
  const visual = { type: 'plot', title: 'Taylor en zéro', x: { min: -2, max: 2 }, parameters: [{ name: 'n', label: 'Degré du polynôme', min: 0, max: 8, step: 1, value: 2 }], series: [{ label: 'Exponentielle', expression: 'exp(x)' }, { label: 'Taylor', expression: 'sum(k,0,n,x^k/factorial(k))' }] };
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: JSON.stringify({ sections: [{ markdown: '# Comprendre Taylor\n\nModifie le degré autour de zéro.', visual }, { markdown: 'Vérifie aussi la convergence.', visual: null }] }), model: 'test-model' }));
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Crée un cours interactif sur Taylor');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  expect(await screen.findByRole('slider', { name: /Degré du polynôme/ })).toHaveValue('2');
  const system = generate.mock.calls[0][0][0].content;
  expect(system).toContain('student-visual');
  expect(system).toContain('Never invent a measurement');
  expect(system).toContain('Never emit JavaScript');
  expect(system).toContain('Do not refuse a general educational request');
  expect(generate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ responseFormat: expect.objectContaining({ type: 'json_schema' }) }));
  await waitFor(() => expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('Taylor en zéro'));
  expect(generate).toHaveBeenCalledTimes(1);
});

it('returns the question to the composer when a structured answer is incomplete without another model call', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(async () => ({ content: '{"sections":[', model: 'test-model' }));
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  await user.type(composer, 'Crée une visualisation de Taylor');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('incomplete or invalid lesson response');
  expect(composer).toHaveValue('Crée une visualisation de Taylor');
  expect(generate).toHaveBeenCalledTimes(1);
});

it('keeps a user-pasted visual specification as code rather than a second interactive answer', async () => {
  const user = userEvent.setup();
  const workspace = createFixtureWorkspace();
  const lesson = workspace.lessonWorkspaces![workspace.activeLessonId];
  lesson.chat = [{ id: 'pasted-code', role: 'user', content: '```student-visual\n{"type":"quiz","title":"Pasted","question":"Q?","options":["A","B"],"answer":0,"explanation":"A"}\n```' }];
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  render(<App provider={null} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByLabelText('Your message').querySelector('code.language-student-visual')).toBeInTheDocument();
});
