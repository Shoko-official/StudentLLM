import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';
import type { ProviderMessage } from './lib/llm-provider';

beforeEach(() => { vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false'); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('answers an unmatched course question using actual prior dialogue instead of an application abstention', async () => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].chat = [
    { id: 'earlier-user', role: 'user', content: 'Je fixe la température à 275 K pour cette discussion.' },
    { id: 'earlier-assistant', role: 'assistant', content: 'Nous utiliserons 275 K.' },
  ];
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: 'Avec la température déjà choisie, voici une explication générale.', model: 'test-context-model' }));
  const user = userEvent.setup();
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Dans ce cours, comment appliquer cela au gaz parfait ?');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  expect(await screen.findByText('Avec la température déjà choisie, voici une explication générale.')).toBeInTheDocument();
  const messages = generate.mock.calls[0][0];
  expect(messages).toContainEqual({ role: 'user', content: 'Je fixe la température à 275 K pour cette discussion.' });
  expect(messages).toContainEqual({ role: 'assistant', content: 'Nous utiliserons 275 K.' });
  expect(messages.at(-1)).toEqual({ role: 'user', content: 'Dans ce cours, comment appliquer cela au gaz parfait ?' });
  expect(messages[0].content).not.toContain('Not enough evidence');
});

it('sends all available course text when it fits, including later passages without embedding it', async () => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].transcript = Array.from({ length: 24 }, (_, index) => ({ id: `passage-${index}`, timestamp: `00:${index}`, speaker: 'Teacher', text: `Le chapitre ${index} contient la constante REPERE_${index}.` }));
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: 'Les passages tardifs sont aussi présents.', model: 'test-context-model' }));
  const embed = vi.fn();
  const user = userEvent.setup();
  render(<App provider={{ generate, embed }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explique le chapitre 0');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  const sourceData = generate.mock.calls[0][0].filter(message => message.role !== 'system').map(message => message.content).join('\n');
  expect(sourceData).toContain('REPERE_0'); expect(sourceData).toContain('REPERE_23');
  expect(generate.mock.calls[0][0][0].content).not.toContain('REPERE_23');
  expect(embed).not.toHaveBeenCalled();
});

it('includes later chapters in study material and keeps source text out of system instructions', async () => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].transcript = Array.from({ length: 24 }, (_, index) => ({ id: `chapter-${index}`, timestamp: `00:${index}`, speaker: 'Teacher', text: `CHAPTER_${index}: Course concept ${index}.` }));
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: 'A guide covering the later chapters.', model: 'test-context-model' }));
  const embed = vi.fn();
  const user = userEvent.setup();
  render(<App provider={{ generate, embed }} />);
  await user.click(screen.getByRole('tab', { name: 'Study' }));
  await user.click(screen.getByRole('button', { name: /Study guide/ }));
  expect(await screen.findByText('A guide covering the later chapters.')).toBeInTheDocument();
  const messages = generate.mock.calls[0][0];
  expect(messages[0].content).not.toContain('CHAPTER_');
  const data = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  expect(data).toContain('CHAPTER_0'); expect(data).toContain('CHAPTER_23');
  expect(messages.at(-1)?.content).toBe('Generate the study guide.');
  expect(embed).not.toHaveBeenCalled();
});

it('links later relevant provided context instead of always linking the first three sources', async () => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].transcript = Array.from({ length: 16 }, (_, index) => ({ id: `source-${index}`, timestamp: `00:${String(index).padStart(2, '0')}`, speaker: 'Teacher', text: index === 13 ? 'The ZEPHYR_CONSTANT is 42.' : `Unrelated concept ${index}.` }));
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  const user = userEvent.setup();
  render(<App provider={{ generate: async () => ({ content: 'The constant is 42.', model: 'test-model' }) }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'What is the ZEPHYR_CONSTANT?');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('button', { name: 'Transcript · 00:13' })).toBeInTheDocument();
  expect(screen.getByLabelText('Response context')).toHaveTextContent('not verified answer citations');
});

it('opens a notes context link after its course identifier changed during transfer', async () => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].chat = [{ id: 'transferred-answer', role: 'assistant', content: 'An explanation.', citations: ['Course notes'], citationTargets: ['note:original-course-id:0'] }];
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  const user = userEvent.setup();
  render(<App provider={null} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  await user.click(screen.getByRole('button', { name: 'Course notes' }));
  expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
});
