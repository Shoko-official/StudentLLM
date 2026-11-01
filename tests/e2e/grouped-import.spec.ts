import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';
import { savedWorkspace } from './workspace-store';

test('a mixed source selection remains in one course, keeps all note sections and survives reload', async ({ page }) => {
  await page.addInitScript((workspace) => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
  }, createFixtureWorkspace());
  await page.route('**/extract', (route) => {
    const first = route.request().postDataBuffer()?.includes(Buffer.from('Intro'));
    return route.fulfill({ json: { model: 'fixture-extractor', pages: [{ pageNumber: 1, text: first ? 'Introduction document evidence.' : 'Tutorial document evidence.', blocks: [] }] } });
  });
  await page.goto('/');
  await page.getByLabel('Select course source').setInputFiles([
    { name: 'TD.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 TD') },
    { name: 'Notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Plain notes remain beside the documents.') },
    { name: 'Intro.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 Intro') },
  ]);
  await expect(page.getByRole('button', { name: 'Stop after this file' })).toHaveCount(0);
  const note = page.getByRole('region', { name: 'Course notes document' });
  const ordered = ['The square-root factor', 'Introduction document evidence.', 'Plain notes remain beside the documents.', 'Tutorial document evidence.'];
  for (const text of ordered) await expect(note).toContainText(text);
  const rendered = await note.innerText();
  const positions = ordered.map((text) => rendered.indexOf(text));
  expect(positions).toEqual(positions.slice().sort((a, b) => a - b));
  const saved = await savedWorkspace(page);
  expect(saved.lessons).toHaveLength(createFixtureWorkspace().lessons.length);
  expect(saved.lessonWorkspaces[FIXTURE_LESSON_ID].resources).toHaveLength(4);
  await page.reload();
  for (const text of ordered) await expect(note).toContainText(text);
  const restored = await note.innerText();
  const restoredPositions = ordered.map((text) => restored.indexOf(text));
  expect(restoredPositions).toEqual(restoredPositions.slice().sort((a, b) => a - b));
  await page.getByRole('tab', { name: /^Sources/ }).click();
  for (const name of ['Intro.pdf', 'TD.pdf', 'Notes.md']) await expect(page.getByRole('button', { name: `Remove source ${name}` })).toBeVisible();
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

test('Undo restores its document section without losing a later import, including after reload', async ({ page }) => {
  await page.addInitScript((workspace) => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
  }, createFixtureWorkspace());
  await page.route('**/extract', (route) => route.fulfill({ json: {
    model: 'fixture-extractor', pages: [{ pageNumber: 1, text: `Evidence ${route.request().postDataBuffer()!.toString()}.`, blocks: [] }],
  } }));
  const file = (name: string) => ({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(name) });
  await page.goto('/');
  await page.getByLabel('Select course source').setInputFiles([file('alpha'), file('beta')]);
  await expect(page.getByText('Import finished. 2 files processed.', { exact: true })).toBeVisible();
  const original = (await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID];
  const alphaId = original.resources.find((resource: { name: string }) => resource.name === 'alpha.pdf').id;
  const prefix = `${alphaId}:`;
  const alphaBlocks = original.courseNote.blocks.filter((block: { id: string }) => block.id.startsWith(prefix));
  await page.getByRole('tab', { name: /^Sources/ }).click();
  await page.getByRole('button', { name: 'Remove source alpha.pdf' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).hover();
  await page.getByLabel('Select course source').setInputFiles(file('gamma'));
  await expect(page.getByText('gamma.pdf indexed 1 page locally.', { exact: true })).toBeVisible();
  const changedBlocks = (await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID].courseNote.blocks;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  const note = page.getByRole('region', { name: 'Course notes document' });
  for (const name of ['alpha', 'beta', 'gamma']) await expect(note).toContainText(`Evidence ${name}.`);
  const saved = (await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID];
  expect(saved.courseNote.blocks.filter((block: { id: string }) => block.id.startsWith(prefix))).toEqual(alphaBlocks);
  expect(saved.courseNote.blocks.filter((block: { id: string }) => !block.id.startsWith(prefix))).toEqual(changedBlocks);
  await page.reload();
  for (const name of ['alpha', 'beta', 'gamma']) await expect(note).toContainText(`Evidence ${name}.`);
});
