import { expect, test } from '@playwright/test';
import { createFixtureWorkspace } from '../../src/test/workspace-fixture';
import { readStoredValue, savedWorkspace, WORKSPACE_KEY } from './workspace-store';

// Real-browser checks for the ways a student could lose work without noticing. The workspace lives in IndexedDB.

test.describe('data safety', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/lm-studio/v1/models', (route) => route.fulfill({ json: { data: [] } }));
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
    }, createFixtureWorkspace());
  });

  test('alerts instead of claiming success when the browser storage is full', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    // The browser reports a full store when the write is committed: the transaction aborts.
    await page.evaluate((key) => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, name?: IDBValidKey) {
        const request = original.call(this, value, name);
        if (name === key) this.transaction.abort();
        return request;
      };
    }, WORKSPACE_KEY);

    await page.setInputFiles('input[aria-label="Select course source"]', { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Notes that cannot be stored.') });
    await expect(page.getByRole('alert')).toContainText('Your changes are not being saved');
    await expect(page.getByRole('alert').getByRole('button', { name: 'Export this course' })).toBeVisible();
  });

  test('keeps a copy of a damaged workspace and says so', async ({ page }) => {
    const damaged = '{"version":1,"activeLessonId":"a","lessons":[{"id":"a","subject":"Maths"';
    await page.addInitScript((value) => localStorage.setItem('studentllm.workspace.v1', value), damaged);
    await page.goto('/');

    await expect(page.getByRole('alert')).toContainText('could not be read');
    await expect(page.getByRole('alert')).toContainText('A copy of the original data was kept');
    // The copy is kept next to the workspace, in IndexedDB, and the damaged value itself is left in localStorage.
    expect(await readStoredValue(page, 'studentllm.workspace.v1.unreadable-backup')).toBe(damaged);
    expect(await page.evaluate(() => localStorage.getItem('studentllm.workspace.v1'))).toBe(damaged);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a second tab cannot overwrite what the first one saved', async ({ page, context }) => {
    await page.goto('/');
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();

    // The first tab adds a course and saves it.
    await page.getByRole('button', { name: 'New course' }).click();
    await page.getByLabel('Course title').fill('Written in the first tab');
    await page.getByRole('button', { name: /^Create course/ }).click();
    await expect.poll(async () => (await savedWorkspace(page)).lessons.map((lesson: { title: string }) => lesson.title)).toContain('Written in the first tab');

    // The second tab was told, stops saving, and its own change does not reach storage.
    await expect(other.getByRole('alert')).toContainText('changed in another tab or window');
    await other.getByRole('button', { name: 'New course' }).click();
    await other.getByLabel('Course title').fill('Written in the stale tab');
    await other.getByRole('button', { name: /^Create course/ }).click();
    await other.waitForTimeout(500);
    const titles = (await savedWorkspace(page)).lessons.map((lesson: { title: string }) => lesson.title);
    expect(titles).toContain('Written in the first tab');
    expect(titles).not.toContain('Written in the stale tab');

    await other.getByRole('button', { name: 'Reload' }).click();
    await expect(other.getByRole('button', { name: 'Written in the first tab' })).toBeVisible();
    await expect(other.getByRole('alert')).toHaveCount(0);
  });

  test('a dropped file is imported and the page does not navigate away', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    const url = page.url();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['Dropped lecture notes.'], 'dropped.md', { type: 'text/markdown' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });

    await expect(page.getByText(/dropped\.md added to course sources/)).toBeVisible();
    expect(page.url()).toBe(url);
  });
});
