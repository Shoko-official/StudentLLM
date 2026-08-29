import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

test.describe('StudentLLM workspace', () => {
  test('has no serious or critical automated accessibility violations', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/', { timeout: 60_000 });

    const results = await new AxeBuilder({ page }).analyze();
    const blockingViolations = results.violations.filter((violation) =>
      violation.impact === 'serious' || violation.impact === 'critical',
    );

    expect(blockingViolations).toEqual([]);
  });

  test('keeps the mobile layout accessible and within the viewport', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { timeout: 60_000 });

    const results = await new AxeBuilder({ page }).analyze();
    const blockingViolations = results.violations.filter((violation) =>
      violation.impact === 'serious' || violation.impact === 'critical',
    );

    expect(blockingViolations).toEqual([]);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  });

  test('supports the core course to Studio workflow', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeVisible();
    await page.getByRole('button', { name: /Targeted quiz/ }).click();
    await expect(page.getByText('Recently created')).toBeVisible();
    await expect(page.getByText('Targeted quiz').last()).toBeVisible();
  });

  test('searches course content and exposes the review queue', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /Global search/ }).click();
    await page.getByRole('textbox', { name: 'Search all course content' }).fill('square-root factor');
    await expect(page.getByRole('button', { name: /square-root factor/ })).toContainText('Attention & Scaled Dot-Product');
    await page.getByRole('button', { name: /square-root factor/ }).click();
    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();

    await page.getByRole('button', { name: /Needs review/ }).click();
    await expect(page.getByRole('dialog', { name: 'Needs review 1' })).toContainText('Without this normalization');
  });

  test('opens the complete transcript and Studio panels', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'View all' }).click();
    await expect(page.getByRole('dialog', { name: 'Full transcript 3' })).toContainText('Without this normalization');
    await page.getByRole('button', { name: 'Close full transcript' }).click();

    await page.getByRole('button', { name: /Open full Studio/ }).click();
    const studio = page.getByRole('dialog', { name: 'Full Studio' });
    await studio.getByRole('button', { name: /Quick summary/ }).click();
    await expect(studio).toContainText('Draft quick summary for Attention & Scaled Dot-Product.');
  });

  test('applies Settings transcript visibility preferences', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('checkbox', { name: /Show verified transcript segments/ }).uncheck();
    await expect(page.getByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).toBeHidden();
    await expect(page.getByText('Without this normalization, dot products grow with the key dimension.')).toBeVisible();
  });

  test('supports transcript review state changes', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Mark segment 01:15:02 verified' }).click();
    await expect(page.getByText('Transcript segment verified.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark segment 01:15:02 for review' })).toBeVisible();
  });

  test('persists a Studio artifact preview after a browser reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Targeted quiz/ }).click();
    await expect(page.getByRole('button', { name: 'Open artifact Targeted quiz' })).toBeVisible();
    await expect(page.getByText(/Draft targeted quiz for Attention & Scaled Dot-Product/)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Open artifact Targeted quiz' })).toBeVisible();
    await expect(page.getByText(/Draft targeted quiz for Attention & Scaled Dot-Product/)).toBeVisible();
  });

  test('isolates new-course transcript content', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /New course/ }).click();
    await page.getByLabel('Course title').fill('Isolated course');
    await page.getByRole('button', { name: /Create and prepare/ }).click();
    await page.getByRole('button', { name: 'Bookmark this passage' }).click();
    await expect(page.getByText('Student bookmark: review this point in the course.')).toBeVisible();

    await page.getByRole('button', { name: /Attention & Scaled Dot-Product/ }).last().click();
    await expect(page.getByText('Student bookmark: review this point in the course.')).toBeHidden();

    await page.getByRole('button', { name: /Isolated course/ }).last().click();
    await expect(page.getByText('Student bookmark: review this point in the course.')).toBeVisible();
  });

  test('supports chat questions and responsive navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Explain the role of normalization.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Explain the role of normalization.')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('complementary', { name: 'Course Studio' })).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeHidden();
  });

  test('keeps mobile navigation closed until requested', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeHidden();
  });

  test('restores chat history after a browser reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('What is the key normalization idea?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('What is the key normalization idea?')).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Chat' }).click();
    await expect(page.getByText('What is the key normalization idea?')).toBeVisible();
  });

  test('keeps source retrieval usable after the browser goes offline', async ({ page, context }) => {
    const unexpectedNetworkRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        if (!isLocal) unexpectedNetworkRequests.push(request.url());
      }
    });

    await page.goto('/');
    await context.setOffline(true);
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'offline-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Offline notes explain gradient clipping.'),
    });
    await expect(page.getByText(/offline-notes\.md added to course sources/)).toBeVisible();

    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('What do the offline notes explain?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: /Source .*offline-notes\.md/ })).toBeVisible();
    expect(unexpectedNetworkRequests).toEqual([]);
  });

  test('recovers the default workspace when persisted JSON is corrupted', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('studentllm.workspace.v1', '{corrupted workspace');
    });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeVisible();
    await expect(page.getByText('corrupted workspace')).toBeHidden();
  });

  test('rejects a malformed course export without changing the active workspace', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Import course export"]', {
      name: 'broken.studentllm.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"studentllm-course","version":1}'),
    });

    await expect(page.getByText('The course import could not be completed.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Self-attention and Context' })).toBeVisible();
  });

  test('dismisses the delete dialog with Escape', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Delete course' }).click();
    await expect(page.getByRole('dialog')).toContainText('Delete Attention & Scaled Dot-Product?');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('captures a browser audio chunk and reports local persistence', async ({ page }) => {
    await page.addInitScript(() => {
      const track = { stop: () => undefined };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
      });

      class BrowserRecorderMock {
        static isTypeSupported = () => false;
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;

        start() {
          queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['browser chunk'], { type: 'audio/webm' }) }));
        }

        stop() {
          this.onstop?.();
        }
      }

      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: BrowserRecorderMock });
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Microphone active, audio autosave ready.')).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText('1 audio chunks saved locally.')).toBeVisible();
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();
    await page.getByRole('button', { name: /^Attention & Scaled Dot-Product audio\.webm Audio · 1 chunk$/ }).click();
    await expect(page.getByRole('dialog', { name: /Attention & Scaled Dot-Product audio\.webm/ })).toContainText('Original source');
    await expect(page.locator('audio.source-audio-preview')).toBeVisible();
    await page.getByRole('button', { name: 'Close source preview' }).click();

    const storedChunkCount = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('studentllm-recordings', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction('audio-chunks', 'readonly');
        const countRequest = transaction.objectStore('audio-chunks').count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      };
    }));

    expect(storedChunkCount).toBe(1);
  });

  test('recovers durable audio after an interrupted browser session', async ({ page }) => {
    await page.addInitScript(() => {
      const track = { stop: () => undefined };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
      });

      class BrowserRecorderMock {
        static isTypeSupported = () => false;
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;

        start() {
          queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['interrupted audio'], { type: 'audio/webm' }) }));
        }

        stop() {
          this.onstop?.();
        }
      }

      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: BrowserRecorderMock });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Microphone active, audio autosave ready.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const raw = window.localStorage.getItem('studentllm.recording-recovery.v1');
      return raw ? JSON.parse(raw).recordings?.length ?? 0 : 0;
    })).toBe(1);

    await page.reload();
    await expect(page.getByText('1 audio chunk recovered from an interrupted session.')).toBeVisible();
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();
  });

  test('reports a clear recording fallback when microphone APIs are unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Demo mode active: microphone unavailable.')).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText('Demo session ended.')).toBeVisible();
  });

  test('imports and stores the original source blob locally', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'lecture-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Week one'),
    });

    await expect(page.getByRole('button', { name: 'lecture-notes.md Text · 10 B' })).toBeVisible();
    await expect(page.getByText(/lecture-notes\.md added to course sources and saved locally\./)).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'lecture-notes.md Text · 10 B' })).toBeVisible();
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('What is in week one?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Source · lecture-notes.md · part 1' })).toBeVisible();

    const storedSource = await page.evaluate(() => new Promise<{ count: number; text: string }>((resolve, reject) => {
      const request = indexedDB.open('studentllm-sources', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const getAllRequest = request.result.transaction('source-blobs', 'readonly').objectStore('source-blobs').getAll();
        getAllRequest.onsuccess = async () => {
          const records = getAllRequest.result as Array<{ blob?: Blob }>;
          resolve({ count: records.length, text: records[0]?.blob ? await records[0].blob.text() : '' });
        };
        getAllRequest.onerror = () => reject(getAllRequest.error);
      };
    }));

    expect(storedSource).toEqual({ count: 1, text: '# Week one' });
  });

  test('imports a source from the course composer attachment action', async ({ page }) => {
    await page.goto('/');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach a file' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'composer-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Composer attachments stay in the active course.'),
    });

    await expect(page.getByText(/composer-notes\.md added to course sources/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^composer-notes\.md Text · 47 B$/ })).toBeVisible();
  });

  test('opens an imported source preview without leaving the workspace', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'preview-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Preview content stays local.'),
    });

    await page.getByRole('button', { name: /^preview-notes\.md Text · 28 B$/ }).click();
    const preview = page.getByRole('dialog', { name: 'preview-notes.md' });
    await expect(preview).toContainText('Original source');
    await expect(preview).toContainText('Preview content stays local.');
    await page.getByRole('button', { name: 'Close source preview' }).click();
    await expect(preview).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
  });

  test('imports and persists a PDF source in the browser workspace', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'slides.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    });

    const source = page.getByRole('button', { name: /^slides\.pdf/ });
    await expect(source).toBeVisible();
    await expect(page.getByText(/slides\.pdf added to course sources and saved locally\./)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: /^slides\.pdf/ })).toBeVisible();
  });

  test('exports and imports a course with source fidelity', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'transfer.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Gradient descent updates parameters.'),
    });
    await expect(page.getByRole('button', { name: /^transfer\.md/ })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export course' }).click();
    const download = await downloadPromise;
    const exportPath = await download.path();
    expect(exportPath).not.toBeNull();
    const exported = await readFile(exportPath as string, 'utf8');
    expect(JSON.parse(exported)).toMatchObject({ format: 'studentllm-course', version: 1 });

    await page.setInputFiles('input[aria-label="Import course export"]', {
      name: download.suggestedFilename(),
      mimeType: 'application/json',
      buffer: Buffer.from(exported),
    });
    await expect(page.getByText('Attention & Scaled Dot-Product imported.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^transfer\.md/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('What updates parameters?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: /Source .*transfer\.md/ })).toBeVisible();
  });

  test('removes an imported source and its local blob', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'remove-me.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('temporary notes'),
    });

    const source = page.getByRole('button', { name: /^remove-me\.md/ });
    await expect(source).toBeVisible();
    await page.getByRole('button', { name: 'Remove source remove-me.md' }).click();
    await expect(page.getByText('remove-me.md removed from this course.')).toBeVisible();
    await expect(source).toBeHidden();

    const storedSourceCount = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('studentllm-sources', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const countRequest = request.result.transaction('source-blobs', 'readonly').objectStore('source-blobs').count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      };
    }));

    expect(storedSourceCount).toBe(0);
  });

  test('deletes a course and clears its source blob', async ({ page }) => {
    await page.addInitScript(() => {
      const track = { stop: () => undefined };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
      });

      class BrowserRecorderMock {
        static isTypeSupported = () => false;
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;

        start() {
          queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['course audio'], { type: 'audio/webm' }) }));
        }

        stop() {
          this.onstop?.();
        }
      }

      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: BrowserRecorderMock });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'course-data.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('course data'),
    });

    await page.getByRole('button', { name: 'Delete course' }).click();
    await expect(page.getByRole('dialog')).toContainText('Delete Attention & Scaled Dot-Product?');
    await page.getByRole('button', { name: 'Delete course permanently' }).click();
    await expect(page.getByRole('heading', { name: 'Self-attention and Context' }).first()).toBeVisible();
    await expect(page.getByText('course-data.md')).toBeHidden();
    await expect(page.getByText('Attention & Scaled Dot-Product deleted.')).toBeVisible();

    const storedSourceCount = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('studentllm-sources', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const countRequest = request.result.transaction('source-blobs', 'readonly').objectStore('source-blobs').count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      };
    }));

    expect(storedSourceCount).toBe(0);

    const storedAudioCount = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('studentllm-recordings', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const countRequest = request.result.transaction('audio-chunks', 'readonly').objectStore('audio-chunks').count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      };
    }));

    expect(storedAudioCount).toBe(0);
  });
});
