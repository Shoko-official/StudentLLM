import { spawn } from 'node:child_process';
import path from 'node:path';
import { $, $$, browser, expect } from '@wdio/globals';

const binaryPath = path.join(process.cwd(), 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'studentllm.exe' : 'studentllm');

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
    await (await visible('//section[contains(@class,"welcome")]//button[normalize-space(.)="Create your first course"]')).click();

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
    await expect(await visible('#view-panel-sources .empty-state')).toHaveText('Add audio, a PDF, an image or text notes to this course.');
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
    await expect(await visible('.study-empty-hint')).toHaveText('Import notes or finish a transcription to enable study material generation.');
    const quickSummary = await visible('//section[contains(@class,"study-view")]//button[strong[normalize-space(.)="Quick summary"]]');
    await expect(quickSummary).toBeDisabled();
    await expect($$('.recent-artifact')).toBeElementsArrayOfSize(0);
    await expect($$('.artifact-preview')).toBeElementsArrayOfSize(0);

    await selectTab('Notes');
    await (await visible('summary[aria-label="Course actions"]')).click();
    await (await visible('//div[@class="course-actions-menu"]//button[normalize-space(.)="Full transcript"]')).click();
    await expect(await visible('[aria-labelledby="transcript-panel-title"] .empty-state')).toHaveText('This course has no transcript segments yet.');
    await (await visible('button[aria-label="Close full transcript"]')).click();

    await (await visible('summary[aria-label="Course actions"]')).click();
    await (await visible('//div[@class="course-actions-menu"]//button[starts-with(normalize-space(.),"Needs review")]')).click();
    await expect(await visible('[aria-labelledby="review-panel-title"] .empty-state')).toHaveText('Nothing needs review.');
    await (await visible('button[aria-label="Close review queue"]')).click();

    await (await visible('summary[aria-label="Course actions"]')).click();
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

  it('keeps the webview on the application when script tries to navigate away', async () => {
    const appOrigin = /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost)(?:[/?#]|$)/;
    await expect(await visible('.topbar')).toBeDisplayed();
    expect(await browser.getUrl()).toMatch(appOrigin);

    // The initial load bypasses Tauri's navigation hook, so this is the only check that the guard denies in a real webview.
    for (const target of ['https://example.com/', 'http://localhost:1234/']) {
      await browser.execute((url) => { window.location.href = url; }, target);
      await browser.pause(3_000);
      expect(await browser.getUrl()).toMatch(appOrigin);
      await expect(await visible('.topbar')).toBeDisplayed();
    }

    // A same-origin navigation still works, so the denial above is the guard and not a frozen page.
    await browser.execute(() => { window.location.hash = '#navigation-guard-check'; });
    await browser.waitUntil(async () => (await browser.getUrl()).endsWith('#navigation-guard-check'), { timeout: 10_000 });
    await browser.execute(() => { window.location.hash = ''; });

    // App-created blob documents (the source previews) must keep loading under the guard, whichever origin the engine writes into the blob URL.
    // An engine that gives the blob an opaque origin makes the frame unreadable from here; a navigation the guard had cancelled would instead
    // leave a readable, empty about:blank document, so "unreadable" also proves the frame navigated.
    const frameState = await browser.executeAsync((done) => {
      const url = URL.createObjectURL(new Blob(['<p>blob preview</p>'], { type: 'text/html' }));
      const frame = document.createElement('iframe');
      frame.id = 'navigation-guard-blob-frame';
      let loaded = false;
      frame.addEventListener('load', () => { loaded = true; });
      frame.src = url;
      document.body.append(frame);
      setTimeout(() => {
        let readable = true;
        let text = null;
        try {
          const doc = frame.contentDocument;
          if (doc === null) readable = false;
          else text = doc.body ? doc.body.textContent : null;
        } catch {
          readable = false;
        }
        frame.remove();
        done({ blobUrlPrefix: url.slice(0, 24), loaded, readable, text });
      }, 5_000);
    });
    console.log(`Blob frame under the navigation guard: ${JSON.stringify(frameState)}`);
    if (frameState.readable) expect(frameState.text).toBe('blob preview');
    else expect(frameState.loaded).toBe(true);
  });

  it('opens no window for window.open or a target="_blank" link', async () => {
    const appOrigin = /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost)(?:[/?#]|$)/;
    await expect(await visible('.topbar')).toBeDisplayed();
    expect(await browser.getWindowHandles()).toHaveLength(1);
    const handleBefore = await browser.getWindowHandle();

    // The window is built in code with an on_new_window hook that refuses every request, and the shell emits "new-window-blocked" when it does.
    // That event is the evidence that the hook is attached: the WebDriver session does not list a window the engine opens by itself, so the
    // handle count alone would also pass for a window created from the configuration file, which has no hook.
    const listening = await browser.executeAsync((done) => {
      window.__newWindowBlocked = [];
      window.__TAURI__.event
        .listen('new-window-blocked', (event) => { window.__newWindowBlocked.push(event.payload); })
        .then(() => done(true), (error) => done(String(error)));
    });
    expect(listening).toBe(true);
    const blockedCount = () => browser.execute(() => window.__newWindowBlocked.length);

    // A script that opens a window without any user gesture. WebKitGTK refuses these itself, before the shell is asked, so no event is required here.
    await browser.execute(() => { window.open('https://example.com/'); });
    await browser.pause(3_000);
    console.log(`Refused new-window requests after a script-only window.open: ${await blockedCount()}`);
    expect(await browser.getWindowHandles()).toHaveLength(1);
    expect(await browser.getUrl()).toMatch(appOrigin);

    // The same two requests from a real click, which every engine passes on to the shell: a button whose handler calls window.open, and a link with
    // target="_blank" (the way the recording notice's links behaved before the packaged app stopped rendering them as links).
    await browser.execute(() => {
      const style = 'position:fixed;left:8px;z-index:2147483647;padding:8px;background:#fff;color:#000;';
      const button = document.createElement('button');
      button.id = 'new-window-guard-button';
      button.type = 'button';
      button.textContent = 'window.open';
      button.style.cssText = `${style}top:8px;`;
      button.addEventListener('click', () => { window.open('https://example.com/', '_blank', 'popup,width=320,height=240'); });
      const link = document.createElement('a');
      link.id = 'new-window-guard-link';
      link.href = 'https://example.com/';
      link.target = '_blank';
      link.textContent = 'Open example.com';
      link.style.cssText = `${style}top:64px;`;
      document.body.append(button, link);
    });
    for (const id of ['new-window-guard-button', 'new-window-guard-link']) {
      const before = await blockedCount();
      await (await visible(`#${id}`)).click();
      await browser.waitUntil(async () => (await blockedCount()) > before, { timeout: 15_000, timeoutMsg: `The click on #${id} did not reach the new-window hook` });
      await browser.pause(2_000);
      expect(await browser.getWindowHandles()).toHaveLength(1);
      expect(await browser.getWindowHandle()).toBe(handleBefore);
      expect(await browser.getUrl()).toMatch(appOrigin);
    }

    // Engines differ in what they report for a script-opened window (the requested address, or about:blank first), so only the shape is checked.
    const events = await browser.execute(() => window.__newWindowBlocked);
    console.log(`Refused new-window requests: ${JSON.stringify(events)}`);
    for (const event of events) {
      expect(typeof event.scheme).toBe('string');
      expect(typeof event.host).toBe('string');
    }
    await browser.execute(() => {
      document.getElementById('new-window-guard-button')?.remove();
      document.getElementById('new-window-guard-link')?.remove();
    });
    await expect(await visible('.topbar')).toBeDisplayed();
  });

  it('hands a second launch of the app over to the running window instead of opening another', async () => {
    await expect(await visible('.topbar')).toBeDisplayed();
    expect(await browser.getWindowHandles()).toHaveLength(1);

    // The second process shares the first one's environment, as a launch from the shortcut would. The lock is held per user session.
    const outcome = await new Promise((resolve) => {
      const child = spawn(binaryPath, [], { stdio: 'ignore', env: process.env });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ timedOut: true, code: null, signal: null });
      }, 30_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ timedOut: false, code: null, signal: null, error: error.message });
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ timedOut: false, code, signal });
      });
    });
    console.log(`Second launch: ${JSON.stringify(outcome)}`);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(0);

    // A second window would take a moment to appear; the first one must still be the only one and still work.
    await browser.pause(3_000);
    expect(await browser.getWindowHandles()).toHaveLength(1);
    await expect(await visible('.topbar')).toBeDisplayed();
  });
});
