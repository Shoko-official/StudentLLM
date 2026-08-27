import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('StudentLLM workspace', () => {
  test('has no serious or critical automated accessibility violations', async ({ page }) => {
    await page.goto('/');

    const results = await new AxeBuilder({ page }).analyze();
    const blockingViolations = results.violations.filter((violation) =>
      violation.impact === 'serious' || violation.impact === 'critical',
    );

    expect(blockingViolations).toEqual([]);
  });

  test('supports the core course to Studio workflow', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeVisible();
    await page.getByRole('button', { name: /Targeted quiz/ }).click();
    await expect(page.getByText('Recently created')).toBeVisible();
    await expect(page.getByText('Targeted quiz').last()).toBeVisible();
  });

  test('supports transcript review state changes', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Mark segment 01:15:02 verified' }).click();
    await expect(page.getByText('Transcript segment verified.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark segment 01:15:02 for review' })).toBeVisible();
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
    await expect(page.getByText('Microphone active, live transcription ready.')).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText('1 audio chunks saved locally.')).toBeVisible();
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();

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
});
