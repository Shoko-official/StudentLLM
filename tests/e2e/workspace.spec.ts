import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';

async function openTranscript(page: Page) {
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  const summary = page.locator('summary').filter({ hasText: /^Transcript \(/ });
  if (!(await summary.evaluate((element) => element.closest('details')!.open))) await summary.click();
}

async function openCourseActions(page: Page) {
  const summary = page.getByLabel('Course actions');
  if (!(await summary.evaluate((element) => element.closest('details')!.open))) await summary.click();
}

const openSources = (page: Page) => page.getByRole('tab', { name: /^Sources/ }).click();
const savedWorkspace = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('studentllm.workspace.v1')!));

async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const elements = [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>('main, aside, .course-note-document, .study-view')];
    return elements.filter((element) => element.getBoundingClientRect().width > 0).map((element) => ({
      element: element.tagName + (element.className ? `.${element.className}` : ''),
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
    }));
  });
  const width = page.viewportSize()!.width;
  for (const box of dimensions) {
    expect(box.scrollWidth, `${box.element} scroll width`).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.left, `${box.element} left edge`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `${box.element} right edge`).toBeLessThanOrEqual(width + 1);
  }
}

async function connectFixtureProvider(page: Page, content: string, status = 200) {
  await page.route('**/fixture-provider/v1/models', (route) => route.fulfill({ json: { data: [{ id: 'fixture-model' }] } }));
  await page.route('**/fixture-provider/v1/chat/completions', (route) => route.fulfill({
    status,
    json: status === 200
      ? { model: 'fixture-model', choices: [{ message: { content } }] }
      : { error: { message: content } },
  }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByLabel('LM Studio address').fill('/fixture-provider/v1');
  await settings.getByLabel('Model', { exact: true }).fill('fixture-model');
  await settings.getByRole('button', { name: 'Save connections' }).click();
  await expect(settings.getByRole('status')).toContainText('Connected. Selected model is available.');
  await settings.getByRole('button', { name: 'Done' }).click();
}

async function installRecorderFixture(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
    });
    class FixtureRecorder {
      static isTypeSupported = () => false;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: 'audio/webm' }) })); }
      stop() { this.onstop?.(); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FixtureRecorder });
  });
}

test.describe('StudentLLM workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/lm-studio/v1/models', (route) => route.fulfill({ json: { data: [] } }));
    await page.addInitScript((workspace) => {
      if (localStorage.getItem('studentllm.workspace.v1') === null) {
        localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
      }
    }, createFixtureWorkspace());
  });
  test('serves the application icon without a browser error', async ({ page }) => {
    const response = await page.request.get('/favicon.svg');

    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/svg+xml');
  });

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
    await expectNoOverflow(page);
    await openTranscript(page);
    await expectNoOverflow(page);
    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
    const navigation = page.getByRole('complementary', { name: 'Course navigation' });
    await expect(navigation).toBeVisible();
    await expect(navigation).toHaveClass(/workspace-sidebar/);
    await expect(navigation.getByText('Workspace')).toBeVisible();
    await expect(navigation.getByText('Courses')).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Quick start', exact: true })).toBeVisible();
    await expectNoOverflow(page);
    await navigation.getByRole('textbox', { name: 'Search courses' }).fill('Matrices');
    await navigation.getByRole('button', { name: 'Matrices and Linear Maps', exact: true }).click();
    await expect(navigation).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Matrices and Linear Maps', level: 1 })).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole('tab', { name: 'Study' }).click();
    await expect(page.getByRole('button', { name: /Targeted quiz/ })).toBeVisible();
    await expectNoOverflow(page);
    const studyResults = await new AxeBuilder({ page }).analyze();
    expect(studyResults.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([]);
  });

  test('supports the core course to Study workflow', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeVisible();
    await connectFixtureProvider(page, 'Why are attention logits scaled?');
    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: /Targeted quiz/ }).click();
    await expect(page.getByRole('heading', { name: 'Saved materials' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open artifact Targeted quiz' })).toBeVisible();
    await expect(page.getByText('Why are attention logits scaled?')).toBeVisible();
  });

  test('uses Quick Start to classify and append a source to the selected course', async ({ page }) => {
    await page.goto('/');
    await connectFixtureProvider(page, JSON.stringify({
      placement: 'existing', targetCourseId: FIXTURE_LESSON_ID, course: 'Machine Learning',
      lesson: 'Transformers', title: 'Cross-attention notes', sublesson: 'Decoder context', subject: 'Machine Learning',
      confidence: 0.93, rationale: 'The excerpt describes decoder queries reading encoder keys.',
    }));
    await page.getByRole('button', { name: 'Quick start', exact: true }).click();
    const quickStart = page.getByRole('dialog', { name: 'Quick start', exact: true });
    await quickStart.getByLabel('Lecture excerpt or course description').fill('Cross-attention lets decoder queries read encoder keys and values.');
    await quickStart.getByRole('button', { name: 'Analyze structure' }).click({ noWaitAfter: true });
    await expect(quickStart.getByLabel('Title')).toHaveValue('Cross-attention notes');
    await expect(quickStart.getByLabel('Sublesson optional')).toHaveValue('Decoder context');
    await expect(quickStart.getByLabel('Place this material in')).toHaveValue(FIXTURE_LESSON_ID);
    await quickStart.getByRole('button', { name: 'Apply structure' }).click();

    await expect(page.getByRole('region', { name: 'Course notes document' })).toContainText('Cross-attention lets decoder queries read encoder keys and values.');
    const workspace = await savedWorkspace(page);
    expect(workspace.lessonWorkspaces[FIXTURE_LESSON_ID].resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ meta: 'Quick Start notes · text source', kind: 'transcript' }),
    ]));
  });

  test('routes a finalized recording to the course selected by the local model', async ({ page }) => {
    await installRecorderFixture(page);
    await page.route('**/fixture-asr/health', (route) => route.fulfill({ json: { status: 'ready', model: 'fixture-asr' } }));
    await page.route('**/fixture-asr/transcribe', (route) => route.fulfill({
      json: {
        model: 'fixture-asr',
        segments: [{ id: 'routing-segment', start: 1, speaker: 'Professor', text: 'Matrices and linear maps preserve structure.' }],
      },
    }));
    await page.goto('/');
    await connectFixtureProvider(page, JSON.stringify({
      placement: 'existing', targetCourseId: 'fixture-linear-algebra', course: 'Mathematics',
      lesson: 'Linear Algebra', sublesson: 'Matrices and Linear Maps', subject: 'Mathematics',
      confidence: 0.94, rationale: 'The lecture explains a defining property of linear maps.',
    }));

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByLabel('Speech service address').fill('/fixture-asr');
    await settings.getByRole('button', { name: 'Save connections' }).click();
    await expect(settings.getByText('fixture-asr · ready')).toBeVisible();
    await settings.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('status')).toContainText('Local transcription added and routed to Matrices and Linear Maps.', { timeout: 120_000 });

    const workspace = await savedWorkspace(page);
    expect(workspace.lessonWorkspaces[FIXTURE_LESSON_ID].resources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'audio' }),
    ]));
    expect(workspace.lessonWorkspaces['fixture-linear-algebra'].resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'audio' }),
    ]));
    expect(workspace.lessonWorkspaces['fixture-linear-algebra'].transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining(':routing-segment'), sourceId: expect.any(String) }),
    ]));
    expect(workspace.lessonWorkspaces['fixture-linear-algebra'].courseNote.folderPath).toEqual([
      'Courses', 'Mathematics', 'Linear Algebra', 'Matrices and Linear Maps',
    ]);
  });

  test('searches course content and exposes the review queue', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /Global search/ }).click();
    await page.getByRole('textbox', { name: 'Search all course content' }).fill('square-root factor');
    await expect(page.getByRole('button', { name: /square-root factor/ })).toContainText('Attention & Scaled Dot-Product');
    await page.getByRole('button', { name: /square-root factor/ }).click();
    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();

    await openCourseActions(page);
    await page.getByRole('button', { name: /Needs review/ }).click();
    await expect(page.getByRole('dialog', { name: 'Needs review 1' })).toContainText('Without this normalization');
  });

  test('opens the complete transcript and Study tab', async ({ page }) => {
    await page.goto('/');

    await openTranscript(page);
    await page.getByRole('button', { name: 'View all' }).click();
    await expect(page.getByRole('dialog', { name: 'Full transcript 3' })).toContainText('Without this normalization');
    await page.getByRole('button', { name: 'Close full transcript' }).click();

    await connectFixtureProvider(page, 'Scaling stabilizes attention logits.');
    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: /Quick summary/ }).click();
    await expect(page.getByText('Scaling stabilizes attention logits.')).toBeVisible();
  });

  test('applies Settings transcript visibility preferences', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const transcriptPreview = page.getByRole('region', { name: 'Transcript preview' });
    await settings.getByRole('checkbox', { name: /Show verified transcript segments/ }).uncheck();
    await settings.getByRole('button', { name: 'Done' }).click();
    await openTranscript(page);
    await expect(transcriptPreview.getByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).toBeHidden();
    await expect(transcriptPreview.getByText('Without this normalization, dot products grow with the key dimension.')).toBeVisible();
  });

  test('traps keyboard focus in dialogs and restores the trigger', async ({ page }) => {
    await page.goto('/');

    const settingsButton = page.getByRole('button', { name: /Settings/ });
    await settingsButton.click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const closeButton = settings.getByRole('button', { name: 'Close settings' });
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(settings.getByRole('button', { name: 'Done' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(settingsButton).toBeFocused();
  });

  test('persists Settings preferences after a browser reload', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 120_000 });

    await page.getByRole('button', { name: /Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('checkbox', { name: /Show verified transcript segments/ }).uncheck();
    await settings.getByRole('checkbox', { name: /Compact transcript spacing/ }).check();

    await page.reload();
    await page.getByRole('button', { name: /Settings/ }).click();
    const reloadedSettings = page.getByRole('dialog', { name: 'Settings' });
    await expect(reloadedSettings.getByRole('checkbox', { name: /Show verified transcript segments/ })).not.toBeChecked();
    await expect(reloadedSettings.getByRole('checkbox', { name: /Compact transcript spacing/ })).toBeChecked();
    await reloadedSettings.getByRole('button', { name: 'Done' }).click();
    await openTranscript(page);
    await expect(page.getByRole('region', { name: 'Transcript preview' })).toHaveClass(/compact/);
    await expect(page.getByRole('region', { name: 'Transcript preview' }).getByText('We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.')).toBeHidden();
  });

  test('supports transcript review state changes', async ({ page }) => {
    await page.goto('/');

    await openTranscript(page);
    await page.getByRole('button', { name: 'Mark segment 01:15:02 verified' }).click();
    await expect(page.getByText('Transcript segment verified.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark segment 01:15:02 for review' })).toBeVisible();
  });

  test('persists a generated artifact preview after a browser reload', async ({ page }) => {
    await page.goto('/');
    await connectFixtureProvider(page, 'Explain how scaling prevents softmax saturation.');
    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: /Targeted quiz/ }).click();
    await expect(page.getByRole('button', { name: 'Open artifact Targeted quiz' })).toBeVisible();
    await expect(page.getByText('Explain how scaling prevents softmax saturation.')).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Open artifact Targeted quiz' }).click();
    await expect(page.getByRole('button', { name: 'Open artifact Targeted quiz' })).toBeVisible();
    await expect(page.getByText('Explain how scaling prevents softmax saturation.')).toBeVisible();
  });

  test('isolates new-course transcript content', async ({ page }) => {
    await installRecorderFixture(page);
    await page.goto('/');

    await page.getByRole('button', { name: /New course/ }).click();
    await page.getByLabel('Course title').fill('Isolated course');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Bookmark this passage' }).click();
    await openTranscript(page);
    await expect(page.getByRole('region', { name: 'Transcript preview' }).getByText('Student bookmark: review this point in the course.')).toBeVisible();

    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await page.getByRole('button', { name: 'Attention & Scaled Dot-Product', exact: true }).click();
    await openTranscript(page);
    await expect(page.getByRole('region', { name: 'Transcript preview' }).getByText('Student bookmark: review this point in the course.')).toBeHidden();

    await page.getByRole('button', { name: 'Isolated course', exact: true }).click();
    await openTranscript(page);
    await expect(page.getByRole('region', { name: 'Transcript preview' }).getByText('Student bookmark: review this point in the course.')).toBeVisible();
  });

  test('supports chat questions and responsive navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Explain the role of normalization.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Explain the role of normalization.')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('complementary', { name: 'Course Studio' })).toBeHidden();
    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeHidden();
    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
    const navigation = page.getByRole('complementary', { name: 'Course navigation' });
    await expect(navigation).toBeVisible();
    await navigation.getByRole('button', { name: 'Matrices and Linear Maps', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Matrices and Linear Maps', level: 1 })).toBeVisible();
    await expect(navigation).toBeHidden();
    await expectNoOverflow(page);
  });

  test('keeps mobile navigation closed until requested', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeHidden();
    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
    await expect(page.getByRole('complementary', { name: 'Course navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
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
    await expect(page.getByRole('button', { name: 'Source · offline-notes.md · part 1', exact: true })).toBeVisible();
    expect(unexpectedNetworkRequests).toEqual([]);

    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: /Quick summary/ }).click();
    await expect(page.getByRole('alert')).toContainText('Connect LM Studio in Settings to generate study material.');
    await expect(page.getByRole('button', { name: /^Open artifact/ })).toHaveCount(0);
    expect((await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([]);
  });

  test('recovers an empty workspace when persisted JSON is corrupted', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('studentllm.workspace.v1', '{corrupted workspace');
    });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'A place for your courses.' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    expect((await savedWorkspace(page)).lessons).toEqual([]);
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

    await openCourseActions(page);
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
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await openSources(page);
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

  test('shows the live transcript preview in the complete transcript panel', async ({ page }) => {
    await page.addInitScript(() => {
      const appWindow = window as Window & { __STUDENTLLM_E2E_SPEECH_ENGINE__?: unknown };
      appWindow.__STUDENTLLM_E2E_SPEECH_ENGINE__ = {
        transcribe: async () => ({
          model: 'e2e-local-asr',
          segments: [{ id: 'live-preview', timestamp: '00:00:01', speaker: 'Speaker', text: 'Preview from the recording.', status: 'review' }],
        }),
      };

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
          queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['preview audio'], { type: 'audio/webm' }) }));
        }

        stop() {
          this.onstop?.();
        }
      }

      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: BrowserRecorderMock });
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
    await openTranscript(page);
    await expect(page.getByRole('region', { name: 'Live course transcription' }).getByText('Preview from the recording.', { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'View all' }).click();
    const transcriptDialog = page.getByRole('dialog', { name: 'Full transcript 3' });
    await expect(transcriptDialog).toContainText('Live preview');
    await expect(transcriptDialog).toContainText('Preview from the recording.');
    await page.getByRole('button', { name: 'Close full transcript' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await expect(page.getByText('Live preview')).toBeHidden();
    await expect(page.getByRole('region', { name: 'Transcript preview' }).getByText('Preview from the recording.', { exact: true })).toBeVisible();
  });

  test('removes a recorded audio source and its persisted chunks', async ({ page }) => {
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
          queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['removable audio'], { type: 'audio/webm' }) }));
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
    await openSources(page);
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();
    await page.getByRole('button', { name: 'Remove source Attention & Scaled Dot-Product audio.webm' }).click();
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm removed from this course.')).toBeVisible();

    const storedChunkCount = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('studentllm-recordings', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const countRequest = request.result.transaction('audio-chunks', 'readonly').objectStore('audio-chunks').count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      };
    }));

    expect(storedChunkCount).toBe(0);
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
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const raw = window.localStorage.getItem('studentllm.recording-recovery.v1');
      return raw ? JSON.parse(raw).recordings?.length ?? 0 : 0;
    })).toBe(1);

    await page.reload();
    await expect(page.getByText('1 audio chunk recovered from an interrupted session.')).toBeVisible();
    await openSources(page);
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();
  });

  test('reports a recording error without fake content when microphone APIs are unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    });
    await page.goto('/');

    const before = (await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID];
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('alert')).toContainText('Cannot start recording:');
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(0);
    await expect(page.getByText(/Demo (mode|session)/)).toHaveCount(0);
    expect((await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID]).toEqual(before);
    await openSources(page);
    await expect(page.getByRole('button', { name: /audio.webm/ })).toHaveCount(0);
  });

  test('imports and stores the original source blob locally', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'lecture-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Week one'),
    });

    await openSources(page);
    await expect(page.getByRole('button', { name: 'lecture-notes.md Text · 10 B' })).toBeVisible();
    await expect(page.getByText(/lecture-notes\.md added to course sources and saved locally\./)).toBeVisible();
    await page.reload();
    await openSources(page);
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

  test('imports a source from the Notes import action', async ({ page }) => {
    await page.goto('/');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import file', exact: true }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'composer-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Composer attachments stay in the active course.'),
    });

    await expect(page.getByText(/composer-notes\.md added to course sources/)).toBeVisible();
    await openSources(page);
    await expect(page.getByRole('button', { name: /^composer-notes\.md Text · 47 B$/ })).toBeVisible();
  });

  test('imports an image from the Sources import action', async ({ page }) => {
    await page.goto('/');
    await openSources(page);
    const sourceInput = page.locator('input[aria-label="Select course source"]');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import file', exact: true }).click();
    const fileChooser = await fileChooserPromise;

    await expect(sourceInput).toHaveAttribute('accept', /image\/\*/);
    await fileChooser.setFiles({
      name: 'course-diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71]),
    });

    await expect(page.getByText(/course-diagram\.png added to course sources/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^course-diagram\.png Image .* 4 B$/ })).toBeVisible();
  });

  test('opens an imported source preview without leaving the workspace', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'preview-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Preview content stays local.'),
    });

    await openSources(page);
    await page.getByRole('button', { name: /^preview-notes\.md Text · 28 B$/ }).click();
    const preview = page.getByRole('dialog', { name: 'preview-notes.md' });
    await expect(preview).toContainText('Original source');
    await expect(preview).toContainText('Preview content stays local.');
    await page.getByRole('button', { name: 'Close source preview' }).click();
    await expect(preview).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();
  });

  test('opens an imported image source preview locally', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'image-preview.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    });

    await openSources(page);
    const source = page.getByRole('button', { name: /^image-preview\.png/ });
    await expect(source).toBeVisible();
    await source.click();

    const preview = page.getByRole('dialog', { name: 'image-preview.png' });
    await expect(preview).toBeVisible();
    await expect(preview.locator('img[alt="Preview of image-preview.png"]')).toBeVisible();
  });

  test('imports and persists a PDF source in the browser workspace', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'slides.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    });

    await openSources(page);
    const source = page.getByRole('button', { name: /^slides\.pdf/ });
    await expect(source).toBeVisible();
    await expect(page.getByText(/slides\.pdf added to course sources and saved locally\./)).toBeVisible();

    await page.reload();
    await openSources(page);
    await expect(page.getByRole('button', { name: /^slides\.pdf/ })).toBeVisible();
  });

  test('exports and imports a course with source fidelity', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'transfer.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Gradient descent updates parameters.'),
    });
    await openSources(page);
    await expect(page.getByRole('button', { name: /^transfer\.md/ })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await openCourseActions(page);
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
    await openSources(page);
    await expect(page.getByRole('button', { name: /^transfer\.md/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('What updates parameters?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Source · transfer.md · part 1', exact: true })).toBeVisible();
  });

  test('removes an imported source and its local blob', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'remove-me.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('temporary notes'),
    });

    await openSources(page);
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
    await openSources(page);
    await expect(page.getByText('Attention & Scaled Dot-Product audio.webm')).toBeVisible();
    await page.setInputFiles('input[aria-label="Select course source"]', {
      name: 'course-data.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('course data'),
    });

    await openCourseActions(page);
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

  test('saves service settings and restores all connection fields after reload', async ({ page }) => {
    await page.route('**/fixture-provider/v1/models', (route) => route.fulfill({ json: { data: [{ id: 'fixture-model' }] } }));
    await page.route('**/fixture-asr/health', (route) => route.fulfill({ json: { model: 'fixture-asr', status: 'ready' } }));
    await page.route('**/fixture-documents/health', (route) => route.fulfill({ json: { model: 'fixture-documents', status: 'ready' } }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const fields = [
      ['LM Studio address', '/fixture-provider/v1'],
      ['Model', 'fixture-model'],
      ['Speech service address', '/fixture-asr'],
      ['Document service address', '/fixture-documents'],
    ];
    for (const [label, value] of fields) await settings.getByLabel(label, { exact: true }).fill(` ${value} `);
    await settings.getByRole('button', { name: 'Save connections' }).click();
    await expect(settings.getByRole('status')).toContainText('Connected. Selected model is available.');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('studentllm.services.v1')!))).toMatchObject({
      llmUrl: '/fixture-provider/v1', model: 'fixture-model', asrUrl: '/fixture-asr', documentsUrl: '/fixture-documents',
    });

    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const [label, value] of fields) await expect(settings.getByLabel(label, { exact: true })).toHaveValue(value);
    await expect(settings.getByRole('status')).toContainText('Connected. Selected model is available.');
    await expect(settings.getByText('fixture-asr · ready', { exact: true })).toBeVisible();
    await expect(settings.getByText('fixture-documents · ready', { exact: true })).toBeVisible();
  });

  for (const failure of [
    { label: 'a failed provider request', content: 'Fixture generation unavailable.', status: 503, error: 'Provider request failed (503): Fixture generation unavailable.' },
    { label: 'an empty provider answer', content: '   ', status: 200, error: 'The model returned no final answer.' },
  ]) {
    test(`does not save study material after ${failure.label}`, async ({ page }) => {
      await page.goto('/');
      await connectFixtureProvider(page, failure.content, failure.status);
      await page.getByRole('tab', { name: 'Study' }).click();
      await page.getByRole('button', { name: /Quick summary/ }).click();
      await expect(page.getByRole('alert')).toContainText(failure.error);
      await expect(page.getByRole('button', { name: /^Open artifact/ })).toHaveCount(0);
      expect((await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID].artifacts).toEqual([]);

      await page.reload();
      await page.getByRole('tab', { name: 'Study' }).click();
      await expect(page.getByRole('heading', { name: 'Saved materials' })).toHaveCount(0);
      expect((await savedWorkspace(page)).artifacts).toEqual([]);
    });
  }

  test('keeps long course, sidebar, source and saved Study content usable at 320px', async ({ page }) => {
    const fixture = createFixtureWorkspace();
    const title = `Fixture course ${'LongCourseName'.repeat(8)}`;
    fixture.lessons[0].title = title;
    fixture.lessons[0].subject = 'LongSubjectName'.repeat(8);
    fixture.lessons[0].chapter = 'LongChapterName'.repeat(8);
    fixture.resources[0].name = `${'long-source-name'.repeat(10)}.txt`;
    fixture.artifacts.push({ id: 'fixture-saved-summary', kind: 'summary', label: 'Quick summary', createdAt: '10 September 2026', content: 'LongStudyContent'.repeat(24) });
    await page.addInitScript((workspace) => localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace)), fixture);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expectNoOverflow(page);
    await openTranscript(page);
    await expectNoOverflow(page);

    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
    const navigation = page.getByRole('complementary', { name: 'Course navigation' });
    await expect(navigation.getByRole('button', { name: title, exact: true })).toBeVisible();
    await expectNoOverflow(page);
    await navigation.getByRole('textbox', { name: 'Search courses' }).fill('Fixture course');
    await navigation.getByRole('button', { name: title, exact: true }).click();
    await expect(navigation).toBeHidden();

    await openSources(page);
    await expect(page.getByRole('button', { name: new RegExp(`^${fixture.resources[0].name}`) })).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Open artifact Quick summary' }).click();
    const preview = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Quick summary', exact: true }) });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(fixture.artifacts[0].content!);
    await expectNoOverflow(page);
    await page.getByRole('button', { name: 'Show or hide navigation' }).click();
    await expectNoOverflow(page);
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
    await expect(navigation).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Study' })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('StudentLLM empty workspace', () => {
  test('starts empty, creates a course and persists imported text notes after reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'A place for your courses.' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByText('Attention & Scaled Dot-Product')).toHaveCount(0);
    expect(await savedWorkspace(page)).toMatchObject({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] });

    await page.getByRole('button', { name: 'Create your first course' }).click();
    await page.getByLabel('Course title').fill('Probability notes');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your notes start here.' })).toBeVisible();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import file', exact: true }).click();
    await (await chooserPromise).setFiles({ name: 'probability.md', mimeType: 'text/markdown', buffer: Buffer.from('Independent event probabilities multiply.') });
    await expect(page.getByRole('region', { name: 'Course notes document' })).toContainText('Independent event probabilities multiply.');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Probability notes', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Course notes document' })).toContainText('Independent event probabilities multiply.');
    await openSources(page);
    await page.getByRole('button', { name: /^probability\.md Text/ }).click();
    await expect(page.getByRole('dialog', { name: 'probability.md' })).toContainText('Independent event probabilities multiply.');
    expect((await savedWorkspace(page)).lessons).toHaveLength(1);
  });

  test('stays empty after deleting the last course and reloading', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create your first course' }).click();
    await page.getByLabel('Course title').fill('Only course');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await openCourseActions(page);
    await page.getByRole('button', { name: 'Delete course', exact: true }).click();
    await page.getByRole('button', { name: 'Delete course permanently' }).click();
    await expect(page.getByRole('heading', { name: 'A place for your courses.' })).toBeVisible();
    expect(await savedWorkspace(page)).toMatchObject({ activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [], lessonWorkspaces: {} });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'A place for your courses.' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Only course', exact: true })).toHaveCount(0);
    expect((await savedWorkspace(page)).lessons).toEqual([]);
  });
});
