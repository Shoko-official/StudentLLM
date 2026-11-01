import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import type { ProviderMessage } from './lib/llm-provider';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';

const saved = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
const pdf = (name: string) => new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
const textOfNote = () => screen.getByRole('region', { name: 'Course notes document' });

beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('keeps both PDF layouts and the previous lecture when an earlier semantic review finishes late', async () => {
  let finishFirst!: (result: { model: string; content: string }) => void;
  const firstReview = new Promise<{ model: string; content: string }>((resolve) => { finishFirst = resolve; });
  const generate = vi.fn(async (messages: ProviderMessage[]) => {
    const prompt = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (prompt.includes('alpha.pdf')) return firstReview;
    if (prompt.includes('beta.pdf')) return { model: 'fixture-model', content: JSON.stringify({ markdown: 'Beta document evidence.', visuals: [] }) };
    return { model: 'fixture-model', content: JSON.stringify({ placement: 'new', title: 'Unwanted course', course: 'Other', lesson: 'Other', subject: 'Other', confidence: 1 }) };
  });
  const extract = vi.fn(async (file: Blob) => ({ model: 'fixture-extractor', pages: [{ pageNumber: 1, text: (file as File).name === 'alpha.pdf' ? 'Alpha document evidence.' : 'Beta document evidence.', blocks: [] }] }));
  const user = userEvent.setup();
  const view = render(<App provider={{ generate }} documentEngine={{ extract }} />);
  await user.upload(screen.getByLabelText('Select course source'), pdf('alpha.pdf'));
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  await user.upload(screen.getByLabelText('Select course source'), pdf('beta.pdf'));
  await waitFor(() => expect(textOfNote()).toHaveTextContent('Beta document evidence.'));
  expect(textOfNote()).toHaveTextContent('Alpha document evidence.');
  expect(textOfNote()).toHaveTextContent('The square-root factor');
  await act(async () => { finishFirst({ model: 'fixture-model', content: JSON.stringify({ markdown: 'Alpha document evidence.', visuals: [] }) }); });
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].courseNote.blocks.filter((block: { id: string }) => block.id.endsWith(':document-semantic-markdown'))).toHaveLength(2));
  expect(textOfNote()).toHaveTextContent('Alpha document evidence.');
  expect(textOfNote()).toHaveTextContent('Beta document evidence.');
  expect(textOfNote()).toHaveTextContent('The square-root factor');
  expect(textOfNote().textContent!.indexOf('Alpha document evidence.')).toBeLessThan(textOfNote().textContent!.indexOf('Beta document evidence.'));
  expect(saved().lessons).toHaveLength(createFixtureWorkspace().lessons.length);
  const ids = saved().lessonWorkspaces[FIXTURE_LESSON_ID].courseNote.blocks.map((block: { id: string }) => block.id);
  expect(new Set(ids).size).toBe(ids.length);
  view.unmount();
  render(<App provider={{ generate }} documentEngine={{ extract }} />);
  expect(textOfNote()).toHaveTextContent('Alpha document evidence.');
  expect(textOfNote()).toHaveTextContent('Beta document evidence.');
  expect(textOfNote().textContent!.indexOf('Alpha document evidence.')).toBeLessThan(textOfNote().textContent!.indexOf('Beta document evidence.'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(extract).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Remove source alpha.pdf' }));
  await user.click(screen.getByRole('tab', { name: 'Notes' }));
  expect(textOfNote()).not.toHaveTextContent('Alpha document evidence.');
  expect(textOfNote()).toHaveTextContent('Beta document evidence.');
  expect(textOfNote()).toHaveTextContent('The square-root factor');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(textOfNote()).toHaveTextContent('Alpha document evidence.');
  expect(textOfNote()).toHaveTextContent('Beta document evidence.');
});

it('deduplicates identical files within one selected batch instead of creating copies in new courses', async () => {
  const user = userEvent.setup();
  render(<App provider={null} />);
  await user.upload(screen.getByLabelText('Select course source'), [
    new File(['Identical source content.'], 'chapter-one.md', { type: 'text/markdown' }),
    new File(['Identical source content.'], 'copy.md', { type: 'text/markdown' }),
  ]);
  await screen.findByText('Import finished. 2 files processed.');
  const workspace = saved();
  expect(workspace.lessons).toHaveLength(createFixtureWorkspace().lessons.length);
  expect(workspace.lessonWorkspaces[FIXTURE_LESSON_ID].resources.filter((resource: { name: string }) => /chapter-one|copy/.test(resource.name))).toHaveLength(1);
  expect(workspace.lessonWorkspaces[FIXTURE_LESSON_ID].transcript.filter((segment: { text: string }) => segment.text === 'Identical source content.')).toHaveLength(1);
});

it('restores a removed document section after another import changes the note, including after reload', async () => {
  const extract = vi.fn(async (file: Blob) => ({
    model: 'fixture-extractor',
    pages: [{ pageNumber: 1, text: `Evidence from ${(file as File).name}.`, blocks: [] }],
  }));
  const user = userEvent.setup();
  const view = render(<App provider={null} documentEngine={{ extract }} />);
  await user.upload(screen.getByLabelText('Select course source'), [pdf('alpha.pdf'), pdf('beta.pdf')]);
  await screen.findByText('Import finished. 2 files processed.');
  const original = saved().lessonWorkspaces[FIXTURE_LESSON_ID];
  const alphaId = original.resources.find((resource: { name: string }) => resource.name === 'alpha.pdf').id;
  const alphaPrefix = `${alphaId}:`;
  const alphaBlocks = original.courseNote.blocks.filter((block: { id: string }) => block.id.startsWith(alphaPrefix));
  expect(alphaBlocks.length).toBeGreaterThan(0);
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Remove source alpha.pdf' }));
  await user.hover(screen.getByRole('button', { name: 'Undo' }));
  await user.upload(screen.getByLabelText('Select course source'), pdf('gamma.pdf'));
  await screen.findByText('gamma.pdf indexed 1 page locally.');
  const changedBlocks = saved().lessonWorkspaces[FIXTURE_LESSON_ID].courseNote.blocks;
  expect(JSON.stringify(changedBlocks)).toContain('Evidence from gamma.pdf.');
  expect(JSON.stringify(changedBlocks)).not.toContain('Evidence from alpha.pdf.');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await user.click(screen.getByRole('tab', { name: 'Notes' }));
  for (const name of ['alpha.pdf', 'beta.pdf', 'gamma.pdf']) expect(textOfNote()).toHaveTextContent(`Evidence from ${name}.`);
  const restored = saved().lessonWorkspaces[FIXTURE_LESSON_ID];
  expect(restored.courseNote.blocks.filter((block: { id: string }) => block.id.startsWith(alphaPrefix))).toEqual(alphaBlocks);
  expect(restored.courseNote.blocks.filter((block: { id: string }) => !block.id.startsWith(alphaPrefix))).toEqual(changedBlocks);
  expect(restored.resources.some((resource: { id: string }) => resource.id === alphaId)).toBe(true);
  expect(restored.transcript.some((segment: { sourceId: string }) => segment.sourceId === alphaId)).toBe(true);
  view.unmount();
  render(<App provider={null} documentEngine={{ extract }} />);
  for (const name of ['alpha.pdf', 'beta.pdf', 'gamma.pdf']) expect(textOfNote()).toHaveTextContent(`Evidence from ${name}.`);
  expect(extract).toHaveBeenCalledTimes(3);
});

it('keeps mixed PDF and text sources in first-appearance order after the initial transcript and reload', async () => {
  const extract = vi.fn(async (file: Blob) => ({
    model: 'fixture-extractor',
    pages: [{ pageNumber: 1, text: `Evidence from ${(file as File).name}.`, blocks: [] }],
  }));
  const user = userEvent.setup();
  const view = render(<App provider={null} documentEngine={{ extract }} />);
  await user.upload(screen.getByLabelText('Select course source'), [
    pdf('TD.pdf'),
    new File(['Middle text material.'], 'Notes.md', { type: 'text/markdown' }),
    pdf('Intro.pdf'),
  ]);
  await screen.findByText('Import finished. 3 files processed.');
  const ordered = ['The square-root factor', 'Evidence from Intro.pdf.', 'Middle text material.', 'Evidence from TD.pdf.'];
  const expectOrder = (text: string) => {
    const indexes = ordered.map((part) => text.indexOf(part));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual(indexes.slice().sort((a, b) => a - b));
  };
  expectOrder(textOfNote().textContent!);
  expectOrder(JSON.stringify(saved().lessonWorkspaces[FIXTURE_LESSON_ID].courseNote.blocks));
  view.unmount();
  render(<App provider={null} documentEngine={{ extract }} />);
  expectOrder(textOfNote().textContent!);
  expect(extract).toHaveBeenCalledTimes(2);
});
