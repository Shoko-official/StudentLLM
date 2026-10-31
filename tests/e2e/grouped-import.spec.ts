import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';
import { savedWorkspace } from './workspace-store';

test('a mixed source selection remains in one course, keeps all note sections and survives reload', async ({ page }) => {
  await page.addInitScript((workspace) => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
  }, createFixtureWorkspace());
  await page.route('**/extract', (route) => {
    const first = route.request().postDataBuffer()?.includes(Buffer.from('Alpha'));
    return route.fulfill({ json: { model: 'fixture-extractor', pages: [{ pageNumber: 1, text: first ? 'Alpha document evidence.' : 'Beta document evidence.', blocks: [] }] } });
  });
  await page.goto('/');
  await page.getByLabel('Select course source').setInputFiles([
    { name: 'Alpha.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 Alpha') },
    { name: 'Beta.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 Beta') },
    { name: 'Notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Plain notes remain beside the documents.') },
  ]);
  await expect(page.getByRole('button', { name: 'Stop after this file' })).toHaveCount(0);
  const note = page.getByRole('region', { name: 'Course notes document' });
  for (const text of ['Alpha document evidence.', 'Beta document evidence.', 'Plain notes remain beside the documents.', 'The square-root factor']) await expect(note).toContainText(text);
  const saved = await savedWorkspace(page);
  expect(saved.lessons).toHaveLength(createFixtureWorkspace().lessons.length);
  expect(saved.lessonWorkspaces[FIXTURE_LESSON_ID].resources).toHaveLength(4);
  await page.reload();
  for (const text of ['Alpha document evidence.', 'Beta document evidence.', 'Plain notes remain beside the documents.']) await expect(note).toContainText(text);
  await page.getByRole('tab', { name: /^Sources/ }).click();
  for (const name of ['Alpha.pdf', 'Beta.pdf', 'Notes.md']) await expect(page.getByRole('button', { name: `Remove source ${name}` })).toBeVisible();
});

test('a folder creates one course in an empty library and can be imported again without duplicates', async ({ page }, testInfo) => {
  const folder = testInfo.outputPath('Probability');
  await mkdir(folder, { recursive: true });
  await writeFile(`${folder}/Chapter 1.md`, 'Events can be independent.');
  await writeFile(`${folder}/Chapter 2.md`, 'Random variables map outcomes to numbers.');
  await page.goto('/');
  await page.getByLabel('Select course folder').setInputFiles(folder);
  const note = page.getByRole('region', { name: 'Course notes document' });
  await expect(page.getByRole('heading', { name: 'Probability', level: 1 })).toBeVisible();
  await expect(note).toContainText('Events can be independent.');
  await expect(note).toContainText('Random variables map outcomes to numbers.');
  await expect.poll(async () => (await savedWorkspace(page)).lessons.length).toBe(1);
  await page.reload();
  await page.getByLabel('Select course folder').setInputFiles(folder);
  await expect(page.getByRole('button', { name: 'Stop after this file' })).toHaveCount(0);
  const saved = await savedWorkspace(page);
  expect(saved.lessons).toHaveLength(1);
  expect(saved.lessonWorkspaces[saved.lessons[0].id].resources).toHaveLength(2);
  expect(saved.lessonWorkspaces[saved.lessons[0].id].transcript).toHaveLength(2);
});

test('dropping several files appends all of them to the open course', async ({ page }) => {
  await page.addInitScript((workspace) => localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace)), createFixtureWorkspace());
  await page.goto('/');
  const transfer = await page.evaluateHandle(() => {
    const value = new DataTransfer();
    value.items.add(new File(['First dropped evidence.'], 'first.md', { type: 'text/markdown' }));
    value.items.add(new File(['Second dropped evidence.'], 'second.md', { type: 'text/markdown' }));
    return value;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  const note = page.getByRole('region', { name: 'Course notes document' });
  await expect(note).toContainText('First dropped evidence.');
  await expect(note).toContainText('Second dropped evidence.');
  const saved = await savedWorkspace(page);
  expect(saved.lessons).toHaveLength(createFixtureWorkspace().lessons.length);
  expect(saved.lessonWorkspaces[FIXTURE_LESSON_ID].resources).toHaveLength(3);
});
