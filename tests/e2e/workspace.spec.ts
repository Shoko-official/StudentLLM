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
});
