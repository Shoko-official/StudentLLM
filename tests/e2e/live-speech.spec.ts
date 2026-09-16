import { expect, test } from '@playwright/test';
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.env.STUDENTLLM_QA_AUDIO ?? ''}`] } });

// Opt-in: requires a real local ASR service, LM Studio, and a public speech WAV.
// This checks the microphone/worklet/HTTP/notes path, not benchmark-level accuracy.
test.describe('real local speech pipeline', () => {
  test.skip(!process.env.STUDENTLLM_QA_AUDIO, 'Set STUDENTLLM_QA_AUDIO to a public French WAV and run the local services.');
  test('streams bounded microphone windows and writes sourced prose', async ({ page }, testInfo) => {
    test.setTimeout(100_000);
    await page.goto('/');
    await page.getByLabel('Course navigation').getByRole('button', { name: 'Quick start', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Selectors are shared with the existing settings flow.
    await page.getByLabel('Speech service address').fill('http://127.0.0.1:8767');
    await page.getByLabel('LM Studio address').fill('/lm-studio/v1');
    await page.getByLabel('Model', { exact: true }).fill('openai/gpt-oss-20b');
    await page.getByRole('button', { name: 'Save connections' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();
    // The isolated test profile acknowledges only its own synthetic microphone session.
    const notice = page.getByRole('dialog', { name: 'Before you record' });
    if (await notice.isVisible()) {
      await notice.getByRole('checkbox').check();
      await notice.getByRole('button', { name: 'I understand and agree' }).click();
    }
    const previews: number[] = [];
    page.on('request', request => {
      if (request.url().includes('mode=preview')) previews.push(request.postDataBuffer()?.length ?? 0);
    });
    const live = page.getByRole('region', { name: 'Live course transcription' });
    await expect(live.locator('.transcript-text').first()).toBeVisible({ timeout: 25_000 });
    await expect(live.getByText('Speaker', { exact: true })).toHaveCount(0);
    const prose = page.getByRole('region', { name: 'Course notes document' }).locator('.course-note-markdown');
    await expect(prose.first()).toBeVisible({ timeout: 55_000 });
    expect(previews.length).toBeGreaterThan(0);
    expect(Math.max(...previews)).toBeLessThanOrEqual(44 + 24 * 48000 * 2);
    await page.screenshot({ path: testInfo.outputPath('live-notes.png'), fullPage: true });
    await testInfo.attach('live-notes', { path: testInfo.outputPath('live-notes.png'), contentType: 'image/png' });
    await testInfo.attach('transcript-and-notes', { body: await live.innerText() + '\n\n' + await prose.allTextContents(), contentType: 'text/plain' });
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled({ timeout: 40_000 });
  });
});
