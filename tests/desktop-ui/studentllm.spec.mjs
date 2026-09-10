import { $, $$, browser, expect } from '@wdio/globals';

async function visible(selector) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout: 60_000 });
  return element;
}

async function courseWithTitle(title) {
  return visible(`button.tree-lesson[aria-label="${title}"]`);
}

async function selectTab(label) {
  const tab = await visible(`//button[@role="tab" and normalize-space(.)="${label}"]`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

describe('StudentLLM packaged desktop workflow', () => {
  it('creates an empty course, explores its views, and persists the course and Settings', async () => {
    const title = 'Desktop WebDriver course';
    const settingsButton = '.topbar button[aria-label="Settings"]';
    const compactPreference = '//section[@aria-labelledby="settings-panel-title"]//label[.//strong[normalize-space(.)="Compact transcript spacing"]]//input[@type="checkbox"]';

    await expect(await visible('.welcome h1')).toHaveText('A place for your courses.');
    await expect($$('button.tree-lesson')).toBeElementsArrayOfSize(0);
    await expect($$('[role="tab"]')).toBeElementsArrayOfSize(0);
    await (await visible('.welcome button.primary-action')).click();

    await expect(await visible('#new-course-title')).toHaveText('Start a course');
    const courseTitle = await visible('input[placeholder="e.g. Introduction to probability"]');
    await courseTitle.setValue(title);
    await (await visible('input[placeholder="e.g. Machine Learning"]')).setValue('Desktop testing');
    await (await visible('input[placeholder="e.g. Transformers"]')).setValue('Native workflow');
    const createCourse = await visible('[role="dialog"][aria-labelledby="new-course-title"] button[type="submit"]');
    await expect(createCourse).toHaveText('Create course');
    await createCourse.click();
    await $('[role="dialog"][aria-labelledby="new-course-title"]').waitForDisplayed({ reverse: true });

    await expect(await courseWithTitle(title)).toHaveAttribute('aria-current', 'page');
    await expect($$('button.tree-lesson')).toBeElementsArrayOfSize(1);
    await expect(await visible('.main-heading h1')).toHaveText(title);
    await expect(await visible('.main-heading p')).toHaveText('Desktop testing / Native workflow');
    await expect($$('[role="tablist"][aria-label="Course view"] [role="tab"]')).toBeElementsArrayOfSize(4);

    await selectTab('Notes');
    await expect(await visible('.note-empty h2')).toHaveText('Your notes start here.');
    await expect(await visible('button[aria-label="Start recording"]')).toBeEnabled();
    await expect($$('.transcript-item')).toBeElementsArrayOfSize(0);

    await selectTab('Sources');
    await expect(await visible('[aria-label="Course sources"] .empty-state')).toHaveText('Add audio, a PDF, an image or text notes to this course.');
    await expect($$('.resource-item')).toBeElementsArrayOfSize(0);

    await selectTab('Chat');
    await expect(await visible('.chat-view .empty-state')).toHaveText('Import material or record a lecture before asking a question.');
    await expect($$('.chat-message')).toBeElementsArrayOfSize(0);
    const composer = await visible('input[aria-label="Ask the course chat"]');
    const send = await visible('button[aria-label="Send"]');
    await composer.setValue(' ');
    await expect(send).toBeDisabled();
    await composer.setValue('What material have I added?');
    await expect(send).toBeEnabled();
    await composer.setValue(' ');
    await expect(send).toBeDisabled();

    await selectTab('Study');
    await expect(await visible('.study-view h2')).toHaveText('Study materials');
    await expect($$('.recent-artifact')).toBeElementsArrayOfSize(0);
    await (await visible('//section[contains(@class,"study-view")]//button[strong[normalize-space(.)="Quick summary"]]')).click();
    const generationError = await visible('[role="alert"] p');
    await expect(generationError).toHaveText(/^(Connect LM Studio in Settings to generate study material\.|Import notes or transcribe a recording before generating study material\.)$/);
    await expect($$('.recent-artifact')).toBeElementsArrayOfSize(0);
    await expect($$('.artifact-preview')).toBeElementsArrayOfSize(0);

    await selectTab('Notes');
    await (await visible('summary[aria-label="Course actions"]')).click();
    await (await visible('//div[@class="course-actions-menu"]//button[normalize-space(.)="Full transcript"]')).click();
    await expect(await visible('[aria-labelledby="transcript-panel-title"] .empty-state')).toHaveText('This course has no transcript segments yet.');
    await (await visible('button[aria-label="Close full transcript"]')).click();

    await (await visible('//div[@class="course-actions-menu"]//button[starts-with(normalize-space(.),"Needs review")]')).click();
    await expect(await visible('[aria-labelledby="review-panel-title"] .empty-state')).toHaveText('Nothing needs review.');
    await (await visible('button[aria-label="Close review queue"]')).click();

    await (await visible('//div[@class="course-actions-menu"]//button[normalize-space(.)="Delete course"]')).click();
    await expect(await visible('#delete-course-title')).toHaveText(`Delete ${title}?`);
    await (await visible('//section[@aria-labelledby="delete-course-title"]//button[normalize-space(.)="Cancel"]')).click();
    await expect(await visible('.main-heading h1')).toHaveText(title);
    await (await visible('summary[aria-label="Course actions"]')).click();

    await (await visible(settingsButton)).click();
    await expect(await visible('#settings-panel-title')).toHaveText('Settings');
    await expect(await visible('input[placeholder="Model identifier in LM Studio"]')).toBeEnabled();
    await expect(await visible('input[placeholder="http://127.0.0.1:8765"]')).toBeEnabled();
    const compact = await visible(compactPreference);
    await expect(compact).not.toBeSelected();
    await compact.click();
    await expect(compact).toBeSelected();
    await (await visible('button[aria-label="Close settings"]')).click();
    await expect(await visible('[aria-label="Managed local services"]')).toHaveText(expect.stringContaining('Managed services'));

    await browser.refresh();
    await expect(await courseWithTitle(title)).toHaveAttribute('aria-current', 'page');
    await expect($$('button.tree-lesson')).toBeElementsArrayOfSize(1);
    await expect(await visible('.main-heading h1')).toHaveText(title);
    await expect(await visible('.main-heading p')).toHaveText('Desktop testing / Native workflow');
    await (await visible(settingsButton)).click();
    await expect(await visible(compactPreference)).toBeSelected();
    await (await visible('button[aria-label="Close settings"]')).click();
    await selectTab('Study');
    await expect($$('.recent-artifact')).toBeElementsArrayOfSize(0);
    await expect($$('.artifact-preview')).toBeElementsArrayOfSize(0);
  });
});
