import { expect, test } from '@playwright/test';
import config from '../../src/lib/nvidia-nim-models.json' with { type: 'json' };

test('NIM is opt-in and Connected requires a real final-answer probe', async ({ page }) => {
  const requests: Array<{ model: string; max_tokens: number; chat_template_kwargs?: { enable_thinking: boolean } }> = [];
  await page.route('**/nvidia-nim/v1/**', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { choices: [{ message: { content: 'OK' } }] } });
  });
  await page.route('**/lm-studio/v1/models', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByLabel('AI provider').selectOption('nvidia-nim');
  await expect(settings.getByRole('note')).toContainText('sent to NVIDIA');
  expect(requests).toHaveLength(0);
  await expect(settings.getByRole('button', { name: 'Save connections' })).toBeEnabled();
  await settings.getByRole('button', { name: 'Save connections' }).click();
  await expect(settings.getByRole('status')).toContainText(`Connected. ${config.defaultModel} answered`);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ model: config.defaultModel, max_tokens: 8, chat_template_kwargs: { enable_thinking: false } });
});

test('a retired NIM selection switches only to a tested fallback and persists across reload', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('studentllm.services.v1')) localStorage.setItem('studentllm.services.v1', JSON.stringify({ llmProvider: 'nvidia-nim', nimModel: 'fixture/retired' }));
  });
  const models: string[] = [];
  await page.route('**/nvidia-nim/v1/**', async (route) => {
    const { model } = route.request().postDataJSON();
    models.push(model);
    await route.fulfill(model === 'fixture/retired'
      ? { status: 410, json: { error: { message: 'Synthetic retired endpoint' } } }
      : { json: { choices: [{ message: { content: 'OK' } }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('status')).toContainText('Switched from fixture/retired');
  await expect(settings.getByRole('status')).toContainText('NVIDIA NIM: Connected.');
  await expect(settings.getByLabel('NVIDIA model')).toHaveValue(config.defaultModel);
  expect(models).toEqual(['fixture/retired', config.defaultModel]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('studentllm.services.v1')!).nimModel)).toBe(config.defaultModel);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText(`Connected. ${config.defaultModel} answered`);
  await expect(settings.getByLabel('NVIDIA model')).toHaveValue(config.defaultModel);
});
