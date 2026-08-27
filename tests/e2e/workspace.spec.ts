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
    await expect(page.getByRole('complementary', { name: 'Navigation des cours' })).toBeVisible();
    await page.getByRole('button', { name: /QCM ciblé/ }).click();
    await expect(page.getByText('Récemment créé')).toBeVisible();
    await expect(page.getByText('QCM ciblé').last()).toBeVisible();
  });

  test('supports chat questions and responsive navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Poser une question au chat' }).fill('Explique le rôle de la normalisation.');
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByText('Explique le rôle de la normalisation.')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('complementary', { name: 'Studio du cours' })).toBeHidden();
    await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
    await expect(page.getByRole('complementary', { name: 'Navigation des cours' })).toBeHidden();
  });
});
