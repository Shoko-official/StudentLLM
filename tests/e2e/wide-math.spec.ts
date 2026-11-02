import { chromium, expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';

const terms = (count: number) => Array.from({ length: count }, (_, index) => `x_{${index + 1}}`).join('+');
const wideFraction = String.raw`\frac{${terms(27)}}{2}`;
const wideRoot = String.raw`\sqrt{${terms(27)}}`;
const wideDelimiters = String.raw`\left(\frac{${terms(4)}}{3}${Array.from({ length: 14 }, (_, index) => String.raw`\cdot y_{${index}}`).join('')}\right)`;
// Formulas whose ink reaches furthest outside KaTeX's boxes. A scroller would cut them, so a formula that fits must not get one.
const overhanging = [
  String.raw`\overbrace{a+b+c}^{n}`, String.raw`\underbrace{a+b}_{k}`, String.raw`\int_0^1 x\,dx`, String.raw`\sum_{i=1}^{n} i`, String.raw`\frac{\frac{a}{b}}{c}`,
  String.raw`\sqrt[3]{x}`, String.raw`\hat{f}`, String.raw`\boxed{x}`, String.raw`\cancel{xy}`, 'f', String.raw`\smash{\frac{a}{b}}`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
  String.raw`\Bigg( x \Bigg)`, String.raw`a\neq b`, String.raw`a\notin B`, String.raw`\xrightarrow[below]{above}`, String.raw`\raisebox{-1em}{x}`, String.raw`x\rlap{ab}`, String.raw`\mathllap{ab}x`,
  String.raw`x\stackrel{\mathclap{\text{by definition}}}{=}y`, String.raw`\mathrel{\rlap{abcdef}}x`, String.raw`{\hspace{-2em}x}`, String.raw`x\hspace{-3em}y`, String.raw`\smash[b]{\underbrace{a+b}_{k+\frac{a}{b}}}`,
];
const fittingMarkdown = ['Words around $e^{i\\pi}+1=0$ share a baseline with the sentence.', 'Short $a+b=c+d$ breaks.', `Operators: words before $${terms(30)}$ words after.`, ...overhanging.map((source, index) => `Ink ${index}: word $${source}$ word.`)].join('\n\n');
// The last ones have a negative space, a lap or a smash in the wide run, and must scroll like any other, with their ink.
const wideSources = [wideFraction, wideRoot, wideDelimiters, String.raw`\overbrace{${terms(27)}}^{n}`, String.raw`${wideFraction}\!`, String.raw`\!${wideFraction}`, String.raw`\sum_{\mathclap{i<j}}${wideFraction}`, String.raw`${wideFraction}\rlap{.}`, String.raw`\mathllap{.}${wideFraction}`, String.raw`\smash{\frac{\frac{a}{b}}{\frac{c}{d}}}{${terms(45)}}`];
const wideMarkdown = [
  fittingMarkdown,
  ...wideSources.map((source, index) => `Wide ${index}: words before $${source}$ words after.`),
  `Stacked: words before $${wideFraction}+${wideRoot}$ words after.`,
  `- List item $${wideFraction}$ tail`,
  `$$${wideFraction}$$`,
  String.raw`$$\overbrace{a+b+c}^{n}\int_0^1 f(x)\,dx$$`,
  `## Heading with $${wideFraction}$ wide`,
  `| Name | Formula |\n| --- | --- |\n| wide | $${wideFraction}$ |\n| short | $x^2$ |`,
].join('\n\n');

const quiet = '.toast-stack { display: none !important; } *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';

// The comparison must not depend on how the compositor antialiases text in a scroller.
test.use({ launchOptions: { args: ['--disable-lcd-text'] } });

async function seed(page: Page, workspace: ReturnType<typeof createFixtureWorkspace>, width: number) {
  await page.addInitScript((fixture) => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(fixture));
    localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  }, workspace);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
}

async function open(page: Page, view: 'chat' | 'notes', content: string, width: number, theme: 'light' | 'dark' = 'light', fileName = 'wide.md') {
  const workspace = createFixtureWorkspace();
  if (view === 'chat') workspace.lessonWorkspaces[FIXTURE_LESSON_ID].chat = [
    { id: 'wide-answer', role: 'assistant', content },
    ...(content === wideMarkdown ? [{ id: 'wide-question', role: 'user' as const, content: `Question: words $${wideFraction}$ words.` }] : []),
  ];
  await seed(page, workspace, width);
  if (theme === 'dark') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('checkbox', { name: /^Dark mode/ }).check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  if (view === 'chat') await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  else await page.setInputFiles('input[aria-label="Select course source"]', { name: fileName, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  const root = page.locator(view === 'chat' ? '.chat-scroll' : '.course-note-content');
  await root.locator('.katex').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: quiet });
  return root;
}

// Counts ink that has nothing within one pixel in the other image: a scroller snaps its content to whole pixels, which is not a loss.
async function lostInk(page: Page, expected: Buffer, actual: Buffer) {
  const blank = await page.context().newPage();
  const lost = await blank.evaluate(async ([want, got]) => {
    const decode = async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [a, b] = [await decode(want), await decode(got)];
    // The most common colour of the expected image is the background; a corner pixel can be a glyph or a scrollbar.
    const counts = new Map<number, number>();
    for (let offset = 0; offset < a.data.length; offset += 4) {
      const colour = a.data[offset] << 16 | a.data[offset + 1] << 8 | a.data[offset + 2];
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    const background = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
    const ink = ({ data }: ImageData) => Uint8Array.from({ length: a.width * a.height }, (_, index) => {
      const offset = index * 4;
      return Math.abs(data[offset] - (background >> 16)) + Math.abs(data[offset + 1] - (background >> 8 & 255)) + Math.abs(data[offset + 2] - (background & 255)) > 150 ? 1 : 0;
    });
    const [wanted, painted] = [ink(a), ink(b)];
    let count = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      if (!wanted[y * a.width + x]) continue;
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) {
        const [nx, ny] = [x + dx, y + dy];
        found = nx >= 0 && ny >= 0 && nx < a.width && ny < a.height && painted[ny * a.width + nx] === 1;
      }
      if (!found) count++;
    }
    return count;
  }, [expected.toString('base64'), actual.toString('base64')]);
  await blank.close();
  return lost;
}

// Compares a scroller with itself at overflow: visible, stepping through the scroll range with a relative offset in the control.
async function expectNoLostInk(page: Page, formula: Locator, label: string) {
  const { scrollWidth, clientWidth } = await formula.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
  const range = Math.max(0, scrollWidth - clientWidth);
  const offsets = [];
  for (let offset = 0; offset < range; offset += Math.max(40, clientWidth - 20)) offsets.push(offset);
  offsets.push(range);
  const content = (node: Element) => node.querySelector('.katex-html') as HTMLElement;
  for (const offset of offsets) {
    const box = await formula.evaluate((node, left) => {
      node.scrollLeft = left;
      node.scrollIntoView({ block: 'center', inline: 'nearest' });
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }, offset);
    // Ink outside the box counts, so the clip goes past it. Where more of the formula is scrolled away on a side, the clip stays
    // inside the box on that side, or the control would show that part. Steps overlap by 20 px, so the inset skips no column.
    const left = offset === 0 ? 40 : -2;
    const right = offset === range ? 40 : -2;
    const viewport = page.viewportSize()!;
    const x = Math.max(0, Math.floor(box.x) - left);
    const y = Math.max(0, Math.floor(box.y) - 30);
    const clip = { x, y, width: Math.min(viewport.width - x, Math.ceil(box.x + box.width) + right - x), height: Math.min(viewport.height - y, Math.ceil(box.height) + 60) };
    const actual = await page.screenshot({ clip });
    await formula.evaluate((node, [left, source]) => {
      const inner = new Function(`return ${source}`)()(node);
      node.scrollLeft = 0;
      inner.style.position = 'relative';
      inner.style.left = `${-left}px`;
      (node as HTMLElement).style.setProperty('overflow', 'visible', 'important');
    }, [offset, content.toString()] as const);
    const expected = await page.screenshot({ clip });
    await formula.evaluate((node, source) => {
      const inner = new Function(`return ${source}`)()(node);
      inner.style.position = '';
      inner.style.left = '';
      (node as HTMLElement).style.removeProperty('overflow');
    }, content.toString());
    expect(await lostInk(page, expected, actual), `${label}, offset ${offset}`).toBeLessThanOrEqual(2);
  }
}

for (const view of ['chat', 'notes'] as const) for (const width of [300, 375, 1280]) for (const theme of ['light', 'dark'] as const) {
  test(`keeps wide formulas readable in ${view} at ${width}px in ${theme} mode`, async ({ page }) => {
    test.setTimeout(180_000);
    const root = await open(page, view, wideMarkdown, width, theme);

    // Below 320px the only overflow comes from body { min-width: 320px }.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(Math.max(width, 320));

    const layout = await root.evaluate((element) => {
      const clipBox = (node: Element) => {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (parent !== document.body && getComputedStyle(parent).overflowX !== 'visible') {
            const left = parent.getBoundingClientRect().left + parent.clientLeft;
            return { left, right: left + parent.clientWidth };
          }
        }
        return { left: 0, right: document.documentElement.clientWidth };
      };
      const scrollers = [...element.querySelectorAll('.katex-scrolls')];
      const unreachable = scrollers.filter((scroller) => {
        const clip = clipBox(scroller);
        const runs = [...scroller.querySelectorAll('.katex-html > .katex-base')];
        const start = Math.min(...runs.map((run) => run.getBoundingClientRect().left));
        scroller.scrollLeft = scroller.scrollWidth;
        const end = Math.max(...runs.map((run) => run.getBoundingClientRect().right));
        scroller.scrollLeft = 0;
        return start < clip.left - 1 || end > clip.right + 1;
      }).length;
      // A formula without a scroller has to fit by itself, or nothing could reach its glyphs.
      const cutOff = [...element.querySelectorAll('.katex-html > .katex-base')].filter((run) => {
        if (run.closest('.katex-scrolls, .katex-display, table')) return false;
        const clip = clipBox(run);
        const { left, right } = run.getBoundingClientRect();
        return left < clip.left - 1 || right > clip.right + 1;
      }).length;
      const lines = (start: string) => {
        const block = [...element.querySelectorAll('p')].find((paragraph) => paragraph.textContent?.startsWith(start))!;
        return new Set([...block.querySelectorAll('.katex-base')].map((run) => Math.round(run.getBoundingClientRect().top))).size;
      };
      const table = element.querySelector('table')!;
      return { scrollers: scrollers.length, unreachable, cutOff, operators: lines('Operators'), tableInside: table.getBoundingClientRect().right <= clipBox(table).right + 1, displays: element.querySelectorAll('.katex-display').length };
    });
    // At 1280px most of these fit their line, which cutOff below checks.
    expect(layout.scrollers).toBeGreaterThanOrEqual(width < 1280 ? wideSources.length : 1);
    expect(layout.unreachable).toBe(0);
    expect(layout.cutOff).toBe(0);
    // An operator stays a break point: the sum wraps instead of scrolling.
    expect(layout.operators).toBeGreaterThan(1);
    expect(layout.tableInside).toBe(true);
    expect(layout.displays).toBe(2);

    const formulas = root.locator('.katex-scrolls, .katex-display');
    const count = await formulas.count();
    for (let index = 0; index < count; index++) await expectNoLostInk(page, formulas.nth(index), `formula ${index}`);
  });
}

for (const view of ['chat', 'notes'] as const) for (const width of [300, 375, 1280]) {
  test(`gives a formula that fits no scroller and no tab stop in ${view} at ${width}px`, async ({ page }) => {
    const root = await open(page, view, fittingMarkdown, width);
    await expect(root.locator('.katex')).toHaveCount(overhanging.length + 3);
    await expect(root.locator('.katex-scrolls')).toHaveCount(0);
    await expect(root.locator('.katex[tabindex]')).toHaveCount(0);
  });
}

// KaTeX stacks hang past their run, so these report more than their box, and here the line is exactly as wide as the box.
const shrinkWrapped = [String.raw`x^2_i`, String.raw`\sqrt{x}`, String.raw`\hat{f}`, String.raw`a_{ij}^{k}`, String.raw`\frac{\frac{a}{b}}{c}`, String.raw`\sqrt{\frac{\sqrt{x}}{y}}`, String.raw`\overbrace{a+b}^{n}`];

for (const width of [375, 1280]) {
  test(`gives a small formula no scroller where its line shrinks to fit it at ${width}px`, async ({ page }) => {
    const table = `| Formula |\n| --- |\n${shrinkWrapped.map((source) => `| $${source}$ |`).join('\n')}`;
    const workspace = createFixtureWorkspace();
    const lesson = workspace.lessonWorkspaces[FIXTURE_LESSON_ID];
    lesson.chat = [{ id: 'table', role: 'assistant', content: table }, ...shrinkWrapped.map((source, index) => ({ id: `user-${index}`, role: 'user' as const, content: `$${source}$` }))];
    lesson.courseNote = {
      id: 'small-note', title: 'Small note', subject: 'Mathematics', chapter: 'Sums', folderPath: [], fileName: 'small-note.md', updatedAt: new Date(0).toISOString(),
      detection: { method: 'LM Studio', confidence: 1, basis: 'Fixture note' },
      blocks: shrinkWrapped.map((source, index) => ({ id: `small-${index}`, type: 'formula' as const, latex: `$${source}$`, caption: 'Small' })),
    };
    await seed(page, workspace, width);
    await expect(page.locator('.course-note-formula .katex')).toHaveCount(shrinkWrapped.length);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.katex-scrolls')).toHaveCount(0);

    await page.setInputFiles('input[aria-label="Select course source"]', { name: 'small.md', mimeType: 'text/markdown', buffer: Buffer.from(table) });
    await expect(page.locator('.course-note-content table .katex')).toHaveCount(shrinkWrapped.length);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.katex-scrolls')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(page.locator('.chat-scroll .katex')).toHaveCount(2 * shrinkWrapped.length);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.katex-scrolls')).toHaveCount(0);
    await expect(page.locator('.chat-scroll .katex[tabindex]')).toHaveCount(0);
  });
}

test('counts the ink past a run', async ({ page }) => {
  // The box of this run is one letter wide, but its ink crosses the line.
  const lap = await open(page, 'chat', String.raw`Words $x\rlap{\text{${'a long lap that crosses the line '.repeat(6)}}}$ words.`, 375);
  await expect(lap.locator('.katex-scrolls')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('scrolls a formula as soon as it passes the line by more than a stack hangs', async ({ page }) => {
  const root = await open(page, 'chat', String.raw`Words $\frac{x_1+x_2+x_3}{2}$ words.`, 375);
  const formula = root.locator('.katex').first();
  const reported = await formula.locator('.katex-base').first().evaluate((run) => run.scrollWidth);
  const style = await page.addStyleTag({ content: '/* set below */' });
  // The padding sets the line to an exact width, and a resize makes RichText measure again.
  const measureWithLine = async (line: number, width: number) => {
    await style.evaluate((tag, value) => { tag.textContent = `.chat-scroll p { padding-right: calc(100% - ${value}px); }`; }, line);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await measureWithLine(reported - 3, 374);
  await expect(formula).not.toHaveClass(/katex-scrolls/);
  await measureWithLine(reported - 5, 373);
  await expect(formula).toHaveClass(/katex-scrolls/);
});

test('counts the padding of the line', async ({ page }) => {
  // This run fits the paragraph at 700px, but not what the padding leaves of it.
  const root = await open(page, 'chat', String.raw`Words $\frac{${terms(10)}}{2}$ words.`, 1280);
  await expect(root.locator('.katex-scrolls')).toHaveCount(0);
  await page.addStyleTag({ content: '.chat-scroll p { padding: 0 40%; }' });
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(root.locator('.katex-scrolls')).toHaveCount(1);
});

test('follows the width of the page', async ({ page }) => {
  const root = await open(page, 'chat', `Words $${wideFraction}$ words.\n\nShort $x^2$ words.`, 1280);
  const formula = root.locator('.chat-message .katex').first();
  await expect(formula).not.toHaveClass(/katex-scrolls/);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(formula).toHaveClass(/katex-scrolls/);
  await expect(formula).toHaveAttribute('tabindex', '0');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(formula).not.toHaveClass(/katex-scrolls/);
  await expect(formula).not.toHaveAttribute('tabindex');
});

test('scrolls a wide formula from the keyboard, outside the hidden KaTeX markup', async ({ page }) => {
  const root = await open(page, 'chat', `Words $${wideFraction}$ words.`, 375);
  const scroller = root.locator('.katex-scrolls').first();
  await scroller.focus();
  expect(await scroller.evaluate((node) => node.closest('[aria-hidden="true"]'))).toBeNull();
  // The padding that holds overhanging ink does not move the formula off the text column.
  expect(await scroller.evaluate((node) => Math.abs(node.querySelector('.katex-html')!.getBoundingClientRect().left - node.closest('p')!.getBoundingClientRect().left))).toBeLessThanOrEqual(1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroller.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect((await new AxeBuilder({ page }).include('.chat-scroll').analyze()).violations).toEqual([]);
});

test('adds a tab stop in notes only where something scrolls', async ({ page }) => {
  const root = await open(page, 'notes', [`$$${wideFraction}$$`, '$$x^2$$', `| A |\n| --- |\n| $${wideFraction}$ |`, '| B |\n| --- |\n| one |'].join('\n\n'), 375);
  await expect(root.locator('.katex-display')).toHaveCount(2);
  await expect(root.locator('.katex-display[tabindex="0"]')).toHaveCount(1);
  await expect(root.locator('table[tabindex="0"]')).toHaveCount(1);
  await expect(root.locator('[tabindex]')).toHaveCount(2);
  expect((await new AxeBuilder({ page }).include('.course-note-content').analyze()).violations).toEqual([]);
});

test('keeps a wide formula in plain-text notes inside the page and keyboard accessible', async ({ page }) => {
  const root = await open(page, 'notes', `Plain text with a wide formula $${wideFraction}$ in the middle.

$$${wideFraction}$$`, 375, 'light', 'plain.txt');
  const scroller = root.locator('.latex-inline.katex-scrolls');
  await expect(scroller).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(scroller).toHaveAttribute('tabindex', '0');
  expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  // Focus inside the img role would not reach assistive technology, so its wrapper scrolls instead.
  await expect(root.locator('[role="img"] [tabindex]')).toHaveCount(0);
  const block = root.locator('.latex-block[tabindex="0"]');
  await block.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => block.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect((await new AxeBuilder({ page }).include('.course-note-content').analyze()).violations).toEqual([]);
});

test('keeps the formula blocks of an organized note inside the page and keyboard accessible', async ({ page }) => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces[FIXTURE_LESSON_ID].courseNote = {
    id: 'wide-note', title: 'Wide note', subject: 'Mathematics', chapter: 'Sums', folderPath: [], fileName: 'wide-note.md', updatedAt: new Date(0).toISOString(),
    detection: { method: 'LM Studio', confidence: 1, basis: 'Fixture note' },
    blocks: [
      { id: 'wide-inline', type: 'formula', latex: wideFraction, caption: 'Inline source' },
      { id: 'wide-display', type: 'formula', latex: `$$${wideFraction}$$`, caption: 'Display source' },
    ],
  };
  await seed(page, workspace, 375);
  const blocks = page.locator('.course-note-formula');
  await expect(blocks).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  await expect(blocks.first().locator('.katex-scrolls')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const scroller of [blocks.first().locator('.katex-scrolls'), blocks.last().locator('.katex-display')]) {
    // Centring in the block must not push the start of a formula out of reach.
    const reach = await scroller.evaluate((node) => {
      const content = node.querySelector('.katex-strut')!.parentElement!;
      const block = node.closest('.course-note-formula')!;
      node.scrollLeft = 0;
      const start = content.getBoundingClientRect().left - block.getBoundingClientRect().left;
      node.scrollLeft = node.scrollWidth;
      const end = content.getBoundingClientRect().right - block.getBoundingClientRect().right;
      return { start, end, scrolls: node.scrollWidth > node.clientWidth, blockScrolls: block.scrollWidth > block.clientWidth };
    });
    expect(reach.scrolls).toBe(true);
    expect(reach.blockScrolls).toBe(false);
    expect(reach.start).toBeGreaterThanOrEqual(0);
    expect(reach.end).toBeLessThanOrEqual(1);
  }
  expect((await new AxeBuilder({ page }).include('.course-note-content').analyze()).violations).toEqual([]);
});

test('shows a usable scrollbar only on a formula that needs it, clear of the next line', async ({ baseURL }) => {
  // Headless Chromium hides scrollbars unless told otherwise, and classic scrollbars take layout space on Windows.
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const page = await (await browser.newContext({ baseURL })).newPage();
    const root = await open(page, 'chat', wideMarkdown, 375);
    const scrollers = root.locator('.katex-scrolls');
    expect(await scrollers.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetHeight <= node.clientHeight).length)).toBe(0);

    for (const start of ['Wide 0', 'Stacked']) {
      const block = root.locator('p').filter({ hasText: new RegExp(`^${start}`) });
      const scroller = block.locator('.katex-scrolls');
      await expect(scroller).toHaveCount(1);
      await block.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const gap = await block.evaluate((element) => {
        const tail = document.createRange();
        tail.selectNode(element.lastChild!);
        return tail.getClientRects()[0].top - element.querySelector('.katex-scrolls')!.getBoundingClientRect().bottom;
      });
      expect(gap, start).toBeGreaterThanOrEqual(0);

      const box = (await scroller.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + box.height - 4);
      await page.mouse.down();
      await page.mouse.move(box.x + 130, box.y + box.height - 4, { steps: 4 });
      await page.mouse.up();
      expect(await scroller.evaluate((node) => node.scrollLeft), start).toBeGreaterThan(0);
    }
  } finally {
    await browser.close();
  }
});
