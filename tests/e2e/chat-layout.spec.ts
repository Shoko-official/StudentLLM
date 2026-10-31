import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';
import { savedWorkspace } from './workspace-store';

test.beforeEach(async ({ page }) => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces[FIXTURE_LESSON_ID].chat = Array.from({ length: 14 }, (_, index) => ({
    id: `chat-layout-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
    content: index % 2
      ? '### The role of normalization\n\nScaling the logits keeps softmax sensitive as the key dimension grows.\n\n- Compare scores on the same scale.\n- Check the original definition before applying it.\n\n$$\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}(QK^T/\\sqrt{d_k})V$$'
      : 'Why does attention divide the dot product by the square root of the key dimension?',
    ...(index % 2 ? { citations: ['transcript.txt, 01:14:18'], citationTargets: ['fixture-segment-2'] } : {}),
  }));
  await page.addInitScript((fixture) => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(fixture));
    localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  }, workspace);
});

test('keeps a multiline composer visible while the conversation scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const history = page.getByRole('region', { name: 'Conversation history' });
  const composer = page.getByRole('textbox', { name: 'Ask the course chat' });
  const dimensions = await history.evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight, top: element.scrollTop }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
  expect(dimensions.top).toBeGreaterThan(0);
  const before = await composer.boundingBox();
  expect(before!.y + before!.height).toBeLessThan(1000);
  await history.evaluate((element) => { element.scrollTop = 0; });
  await composer.fill('Explain attention.');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('Why normalize?');
  await expect(composer).toHaveValue('Explain attention.\nWhy normalize?');
  const after = await composer.boundingBox();
  expect(after!.y + after!.height).toBeLessThan(1000);
  expect(after!.height).toBe(before!.height);
  const messagesBefore = await page.getByLabel('Your message', { exact: true }).count();
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(page.getByLabel('Your message', { exact: true })).toHaveCount(messagesBefore);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.getByLabel('Your message', { exact: true })).toHaveCount(messagesBefore + 1);
  expect((await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID].chat.at(-2).content).toContain('Why normalize?');
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.getByLabel('Your message', { exact: true }).last()).toContainText('Why normalize?');
});

test('fits the mobile viewport in dark mode with keyboard-accessible sources', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: /^Dark mode/ }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Ask the course chat' });
  await expect(composer).toBeVisible();
  const box = await composer.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByText('1 source', { exact: true }).click();
  await page.getByRole('button', { name: 'Open course sources' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /^Sources/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const accessibility = await new AxeBuilder({ page }).include('.chat-view').analyze();
  expect(accessibility.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([]);
});

test('keeps Send reachable in a short window', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 500 });
  await page.goto('/');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(500);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(500);
});

test('moves Undo above the composer when a pasted question expands it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setInputFiles('input[aria-label="Select course source"]', { name: 'toast-chat.md', mimeType: 'text/markdown', buffer: Buffer.from('A synthetic note for source removal.') });
  await page.getByRole('tab', { name: /^Sources/ }).click();
  await page.getByRole('button', { name: 'Remove source toast-chat.md' }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Explain attention.\nCompare the scores.\nExplain softmax.\nShow the formula.\nDiscuss normalization.\nGive an example.');
  await expect.poll(async () => {
    const toast = await page.locator('.toast-undo').boundingBox();
    const composer = await page.locator('.chat-composer').boundingBox();
    return toast!.y + toast!.height <= composer!.y;
  }).toBe(true);
});
