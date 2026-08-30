import { $, $$, browser, expect } from '@wdio/globals';

async function visible(selector) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout: 60_000 });
  return element;
}

async function courseWithTitle(title) {
  await browser.waitUntil(async () => {
    const courses = await $$('button.tree-lesson');
    const labels = [];
    for (let index = 0; index < courses.length; index += 1) {
      labels.push(await courses[index].getAttribute('aria-label'));
    }
    return labels.some((label) => label.includes(title));
  }, {
    timeout: 60_000,
    timeoutMsg: `Course button with title "${title}" was not rendered`,
  });

  const courses = await $$('button.tree-lesson');
  for (let index = 0; index < courses.length; index += 1) {
    const course = courses[index];
    if ((await course.getAttribute('aria-label'))?.includes(title)) return course;
  }

  throw new Error(`Course button with title "${title}" disappeared`);
}

describe('StudentLLM packaged desktop workflow', () => {
  it('creates a course, survives reload, and creates a Studio artifact', async () => {
    await (await visible('button.primary-action')).click();

    const courseTitle = await visible('input[placeholder="e.g. Introduction to probability"]');
    await courseTitle.setValue('Desktop WebDriver course');
    await (await visible('button.primary-submit')).click();

    const course = await courseWithTitle('Desktop WebDriver course');
    await expect(course).toHaveAttribute('aria-label', 'Desktop WebDriver course');

    await browser.refresh();
    await expect(await courseWithTitle('Desktop WebDriver course')).toHaveAttribute('aria-label', 'Desktop WebDriver course');

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
