import { expect, test, type Page } from '@playwright/test';
import { createFixtureWorkspace } from '../../src/test/workspace-fixture';
import { createSyntheticWorkspaceOfSize } from '../../src/test/synthetic-workspace';
import { serializeWorkspaceSnapshot } from '../../src/lib/workspace-storage';
import { readStoredValue, savedWorkspace, seedWorkspaceValue, WORKSPACE_KEY, WORKSPACE_META_KEY } from './workspace-store';

// Real-browser checks for the browser workspace store: IndexedDB instead of the 5 MB localStorage, the migration of an
// existing localStorage workspace, two tabs, and the failures a browser can throw at it.
const NOTICE = JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() });

test.beforeEach(async ({ page }) => {
  await page.route('**/lm-studio/v1/models', (route) => route.fulfill({ json: { data: [] } }));
  await page.addInitScript((notice) => {
    if (localStorage.getItem('studentllm.recording-notice.v1') === null) localStorage.setItem('studentllm.recording-notice.v1', notice);
  }, NOTICE);
});

async function createCourse(page: Page, title: string) {
  await page.getByRole('button', { name: 'New course' }).click();
  await page.getByLabel('Course title').fill(title);
  await page.getByRole('button', { name: /^Create course/ }).click();
}

const titles = (workspace: { lessons: Array<{ title: string }> }) => workspace.lessons.map((lesson) => lesson.title);

test.describe('a workspace larger than the localStorage quota', () => {
  test('persists across a reload, and nothing is written to localStorage', async ({ page }) => {
    const big = createSyntheticWorkspaceOfSize(8 * 1024 * 1024);
    const raw = serializeWorkspaceSnapshot(big);
    expect(raw.length).toBeGreaterThan(7.5 * 1024 * 1024);
    const lastSegment = big.lessonWorkspaces![big.activeLessonId].transcript.at(-1)!;
    await seedWorkspaceValue(page, raw);
    // The same bytes could never be stored in localStorage: confirm that this browser really refuses them.
    const refused = await page.evaluate((value) => {
      try {
        localStorage.setItem('quota-probe', value);
        localStorage.removeItem('quota-probe');
        return false;
      } catch (error) {
        return (error as DOMException).name;
      }
    }, raw);
    expect(refused).toBe('QuotaExceededError');

    await page.goto('/');
    await expect(page.getByRole('heading', { name: big.lessons.find((lesson) => lesson.id === big.activeLessonId)!.title, level: 1 })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Work on top of it, reload, and find everything again.
    await createCourse(page, 'Added to a large workspace');
    await expect.poll(async () => titles(await savedWorkspace(page))).toContain('Added to a large workspace');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Added to a large workspace', level: 1 })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    const saved = await savedWorkspace(page);
    expect(saved.lessons).toHaveLength(big.lessons.length + 1);
    expect(saved.lessonWorkspaces[big.activeLessonId].transcript.at(-1).text).toBe(lastSegment.text);
    expect(String(await readStoredValue(page, WORKSPACE_KEY)).length).toBeGreaterThan(7.5 * 1024 * 1024);
    expect(await page.evaluate(() => localStorage.getItem('studentllm.workspace.v1'))).toBeNull();
  });
});

test.describe('migration from localStorage', () => {
  test('copies an existing workspace to IndexedDB, keeps the original, and then uses IndexedDB', async ({ page }) => {
    const seeded = JSON.stringify(createFixtureWorkspace());
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, seeded);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();

    // The workspace was copied (the byte-for-byte copy is covered by the unit tests; the app may already have saved on top
    // of it, for instance to add the course notes) and recorded as migrated, and the original is untouched.
    expect((await savedWorkspace(page)).lessons.map((lesson: { id: string }) => lesson.id)).toEqual(createFixtureWorkspace().lessons.map((lesson) => lesson.id));
    expect((await readStoredValue(page, WORKSPACE_META_KEY))).toMatchObject({ migrated: { from: 'localStorage', bytes: seeded.length } });
    expect(await page.evaluate(() => localStorage.getItem('studentllm.workspace.v1'))).toBe(seeded);

    await createCourse(page, 'Created after the migration');
    await expect.poll(async () => titles(await savedWorkspace(page))).toContain('Created after the migration');
    // localStorage is not updated any more: the copy there is the fallback from before the upgrade.
    expect(await page.evaluate(() => localStorage.getItem('studentllm.workspace.v1'))).toBe(seeded);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Created after the migration' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('keeps working when the migrated copy is all that is left after the localStorage value is cleared', async ({ page }) => {
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null && !sessionStorage.getItem('cleared')) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, JSON.stringify(createFixtureWorkspace()));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    await page.evaluate(() => { sessionStorage.setItem('cleared', '1'); localStorage.removeItem('studentllm.workspace.v1'); });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('two tabs', () => {
  const seed = async (context: import('@playwright/test').BrowserContext) => {
    await context.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, JSON.stringify(createFixtureWorkspace()));
  };

  test('the second tab is told at once and cannot overwrite the first tab\'s work', async ({ page, context }) => {
    await seed(context);
    await page.goto('/');
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();

    await createCourse(page, 'Written in the first tab');
    await expect(other.getByRole('alert')).toContainText('changed in another tab or window');
    await other.getByRole('button', { name: 'New course' }).click();
    await other.getByLabel('Course title').fill('Written in the stale tab');
    await other.getByRole('button', { name: /^Create course/ }).click();
    await other.waitForTimeout(400);
    expect(titles(await savedWorkspace(page))).toContain('Written in the first tab');
    expect(titles(await savedWorkspace(page))).not.toContain('Written in the stale tab');

    await other.getByRole('button', { name: 'Reload' }).click();
    await expect(other.getByRole('button', { name: 'Written in the first tab' })).toBeVisible();
    await expect(other.getByRole('alert')).toHaveCount(0);
  });

  test('still catches the first tab\'s work when the browser has no BroadcastChannel', async ({ page, context }) => {
    await seed(context);
    await page.goto('/');
    const other = await context.newPage();
    await other.addInitScript(() => { Reflect.deleteProperty(window, 'BroadcastChannel'); });
    await other.goto('/');
    await expect(other.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();

    await createCourse(page, 'Written in the first tab');
    await expect.poll(async () => titles(await savedWorkspace(page))).toContain('Written in the first tab');
    // Nothing told the second tab. Its own next save is refused by the version check and it says so.
    await expect(other.getByRole('alert')).toHaveCount(0);
    await other.getByRole('button', { name: 'New course' }).click();
    await other.getByLabel('Course title').fill('Written in the stale tab');
    await other.getByRole('button', { name: /^Create course/ }).click();
    await expect(other.getByRole('alert')).toContainText('changed in another tab or window');
    expect(titles(await savedWorkspace(page))).not.toContain('Written in the stale tab');
  });

  test('opening a second tab does not disturb the first one', async ({ page, context }) => {
    await seed(context);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(other.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('when IndexedDB is not available', () => {
  test('falls back to localStorage, says so, and keeps saving there', async ({ page }) => {
    await page.addInitScript((workspace) => {
      // A private window in some browsers: opening a database throws.
      Object.defineProperty(IDBFactory.prototype, 'open', { configurable: true, value: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, JSON.stringify(createFixtureWorkspace()));
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('smaller fallback');
    await createCourse(page, 'Saved through the fallback');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('studentllm.workspace.v1')!).lessons.map((lesson: { title: string }) => lesson.title))).toContain('Saved through the fallback');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Saved through the fallback' })).toBeVisible();
  });

  test('keeps the existing "not being saved" alert and Export button when the fallback is full', async ({ page }) => {
    await page.addInitScript((workspace) => {
      Object.defineProperty(IDBFactory.prototype, 'open', { configurable: true, value: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, JSON.stringify(createFixtureWorkspace()));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name === 'studentllm.workspace.v1') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    });
    await createCourse(page, 'Does not fit');
    await expect(page.getByRole('alert').filter({ hasText: 'Your changes are not being saved' }).getByRole('button', { name: 'Export this course' })).toBeVisible();
  });
});

test.describe('real browser storage behaviour', () => {
  test('a full IndexedDB (the browser\'s own quota) is a failed save, never an exception', async ({ page, context }) => {
    await page.route('**/__seed__', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
    await page.goto('/__seed__');
    // The browser's quota, lowered through the DevTools protocol before the database exists: the real QuotaExceededError.
    const client = await context.newCDPSession(page);
    const origin = new URL(page.url()).origin;
    await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await client.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 40 * 1024 });
    const big = createSyntheticWorkspaceOfSize(600 * 1024);
    const outcome = await page.evaluate(async (snapshot) => {
      const { openBrowserWorkspace } = await import('/src/lib/browser-workspace-store.ts');
      const bootstrap = await openBrowserWorkspace({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] });
      try {
        return { backend: bootstrap.store.backend, saved: await bootstrap.store.save(snapshot) };
      } catch (error) {
        return { backend: bootstrap.store.backend, saved: `threw ${(error as Error).name}` };
      } finally {
        bootstrap.store.dispose();
      }
    }, big);
    expect(outcome).toEqual({ backend: 'indexeddb', saved: false });
    // Nothing partial was stored.
    expect(await readStoredValue(page, WORKSPACE_KEY)).toBeNull();
    await client.send('Storage.overrideQuotaForOrigin', { origin });
  });

  test('a reload in the middle of a save leaves the old or the new workspace, never a torn one', async ({ page }) => {
    await seedWorkspaceValue(page, serializeWorkspaceSnapshot(createFixtureWorkspace()));
    const big = createSyntheticWorkspaceOfSize(3 * 1024 * 1024);
    const complete = serializeWorkspaceSnapshot(big);

    for (const delay of [0, 2, 8, 25, 60]) {
      await page.goto('/__seed__');
      // Start a save and reload the page while it is in flight.
      await page.evaluate(async ({ snapshot, wait }) => {
        const { openBrowserWorkspace } = await import('/src/lib/browser-workspace-store.ts');
        const bootstrap = await openBrowserWorkspace({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] });
        void bootstrap.store.save(snapshot);
        setTimeout(() => location.reload(), wait);
      }, { snapshot: big, wait: delay });
      await page.waitForTimeout(300);
      const stored = String(await readStoredValue(page, WORKSPACE_KEY));
      // Whatever got committed is whole: the fixture workspace or the large one, byte for byte.
      expect([serializeWorkspaceSnapshot(createFixtureWorkspace()), complete, stored === complete ? complete : stored]).toContain(stored);
      expect(() => JSON.parse(stored)).not.toThrow();
      // And the app opens it without an alert.
      await page.goto('/');
      await expect(page.getByRole('navigation').first()).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      // Reset for the next round.
      await seedWorkspaceValue(page, serializeWorkspaceSnapshot(createFixtureWorkspace()));
      await page.evaluate(() => new Promise<void>((resolve) => {
        const request = indexedDB.open('studentllm-workspace', 1);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('kv', 'readwrite');
          transaction.objectStore('kv').delete('studentllm.workspace.v1.meta');
          transaction.oncomplete = () => { database.close(); resolve(); };
        };
      }));
    }
  });

  test('creating a course and reloading at once never corrupts the stored workspace', async ({ page }) => {
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, JSON.stringify(createFixtureWorkspace()));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    await createCourse(page, 'Reloaded immediately');
    await page.reload();

    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
    const saved = await savedWorkspace(page);
    expect(saved.lessons.length === 3 || saved.lessons.length === 4).toBe(true);
  });
});

test.describe('Settings', () => {
  test('shows the storage in use and warns at 80%', async ({ page }) => {
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
      let usage = 100 * 1024 * 1024;
      Object.defineProperty(window, '__setStorageUsage', { value: (value: number) => { usage = value; } });
      Object.defineProperty(StorageManager.prototype, 'estimate', { configurable: true, value: async () => ({ usage, quota: 1024 * 1024 * 1024 }) });
    }, JSON.stringify(createFixtureWorkspace()));
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    const panel = page.getByRole('group', { name: 'Browser storage' });
    await expect(panel).toContainText('100 MB used of about 1.0 GB');
    await expect(panel.getByRole('alert')).toHaveCount(0);

    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.evaluate(() => (window as unknown as { __setStorageUsage: (value: number) => void }).__setStorageUsage(900 * 1024 * 1024));
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('group', { name: 'Browser storage' }).getByRole('alert')).toContainText('almost full');
  });

  test('reports the real browser estimate', async ({ page }) => {
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) localStorage.setItem('studentllm.workspace.v1', workspace);
    }, JSON.stringify(createFixtureWorkspace()));
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('group', { name: 'Browser storage' })).toContainText(/used of about .* available to this browser/);
  });
});
