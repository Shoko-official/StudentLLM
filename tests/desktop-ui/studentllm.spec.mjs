import { $, browser, expect } from '@wdio/globals';

async function visible(selector) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout: 60_000 });
  return element;
}

describe('StudentLLM packaged desktop workflow', () => {
  it('creates a course, survives reload, and creates a Studio artifact', async () => {
    await (await visible('button.primary-action')).click();

    const courseTitle = await visible('input[placeholder="e.g. Introduction to probability"]');
    await courseTitle.setValue('Desktop WebDriver course');
    await (await visible('button.primary-submit')).click();

    const course = await visible('button.tree-lesson');
    await expect(course).toHaveText('Desktop WebDriver course');

    await browser.refresh();
    await expect(await visible('button.tree-lesson')).toHaveText('Desktop WebDriver course');

    await (await visible('button.studio-link')).click();
    await expect(await visible('.studio-modal h2')).toHaveText('Full Studio');

    const quickSummary = await visible('.studio-modal button.artifact-button');
    await expect(await quickSummary.getText()).toContain('Quick summary');
    await quickSummary.click();
    await expect(await visible('.studio-modal h3')).toHaveText('Quick summary');

    await browser.refresh();
    await (await visible('button.studio-link')).click();
    await expect(await visible('.studio-modal h3')).toHaveText('Quick summary');
  });
});
