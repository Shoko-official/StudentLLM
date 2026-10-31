import type { Page } from '@playwright/test';

// The browser keeps the workspace in IndexedDB (database `studentllm-workspace`, store `kv`). These helpers read and
// seed it from a test, the way a person's browser holds it.
export const WORKSPACE_KEY = 'studentllm.workspace.v1';
export const WORKSPACE_META_KEY = 'studentllm.workspace.v1.meta';

/** The raw stored value, or null when nothing is stored. */
export function readStoredValue(page: Page, key: string): Promise<unknown> {
  return page.evaluate((storedKey) => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('studentllm-workspace', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('kv', 'readonly').objectStore('kv').get(storedKey);
      read.onsuccess = () => {
        database.close();
        resolve(read.result ?? null);
      };
      read.onerror = () => {
        database.close();
        reject(read.error);
      };
    };
  }), key);
}

/**
 * The saved workspace. Saving is asynchronous, so this waits until the stored value has stopped changing before it
 * answers. Returns null when nothing was ever saved.
 */
export async function savedWorkspace(page: Page): Promise<any> {
  let previous: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await readStoredValue(page, WORKSPACE_KEY);
    if (attempt > 0 && current === previous && current !== null) return JSON.parse(String(current));
    previous = current;
    await page.waitForTimeout(60);
  }
  return previous === null ? null : JSON.parse(String(previous));
}

/** Writes a value straight into IndexedDB, from a page of the same origin that does not run the app. */
export async function seedWorkspaceValue(page: Page, raw: string, key = WORKSPACE_KEY) {
  await page.route('**/__seed__', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
  await page.goto('/__seed__');
  await page.evaluate(({ storedKey, value }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('studentllm-workspace', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('kv', 'readwrite');
      transaction.objectStore('kv').put(value, storedKey);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onabort = () => reject(transaction.error);
    };
  }), { storedKey: key, value: raw });
}
