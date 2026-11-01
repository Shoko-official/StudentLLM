import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';
import { savedWorkspace } from './workspace-store';

const block = (spec: unknown) => '\n\n```student-visual\n' + JSON.stringify(spec) + '\n```\n\n';
const lesson = '# Comprendre Taylor\n\nUn exemple pédagogique centré en zéro : change le degré et compare les deux courbes.' + block({ type: 'plot', title: 'Exponentielle et approximation', description: 'Le polynôme reproduit les dérivées en zéro ; sa qualité dépend de la distance au centre.', x: { min: -2, max: 2, label: 'x' }, parameters: [{ name: 'n', label: 'Degré du polynôme', min: 0, max: 10, step: 1, value: 1 }], series: [{ label: 'Exponentielle', expression: 'exp(x)' }, { label: 'Polynôme de Taylor', expression: 'sum(k,0,n,x^k/factorial(k))' }], outputs: [{ label: 'Approximation en x = 1', expression: 'sum(k,0,n,1/factorial(k))' }] }) + '## Vérifie ta compréhension\n\nLe développement est local.' + block({ type: 'quiz', title: 'La première approximation', question: 'Quel polynôme approche $e^x$ au degré 1 en zéro ?', options: ['$1+x$', '$x^2$', '$1-x$'], answer: 0, explanation: 'La valeur et la dérivée en zéro valent 1.', hint: 'Commence par la valeur et la pente en zéro.' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(workspace => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
    localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  }, createFixtureWorkspace());
});

test('renders a generated visual lesson, recalculates locally and restores the answer after reload', async ({ page }) => {
  const messages: unknown[] = [];
  await page.route('**/fixture-provider/v1/models', route => route.fulfill({ json: { data: [{ id: 'test-visual-model' }] } }));
  await page.route('**/v1/chat/completions', async route => {
    const request = route.request().postDataJSON();
    messages.push(request);
    const sections: Array<{ markdown: string; visual: unknown }> = [];
    let cursor = 0;
    for (const match of lesson.matchAll(/```student-visual\n([\s\S]*?)```/g)) {
      sections.push({ markdown: lesson.slice(cursor, match.index).trim(), visual: JSON.parse(match[1]) });
      cursor = match.index! + match[0].length;
    }
    if (lesson.slice(cursor).trim()) sections.push({ markdown: lesson.slice(cursor).trim(), visual: null });
    expect(request.response_format.json_schema.name).toBe('teaching_answer');
    await route.fulfill({ json: { model: 'test-visual-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sections }) } }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('LM Studio address').fill('/fixture-provider/v1');
  await page.getByLabel('Model', { exact: true }).fill('test-visual-model');
  await page.getByRole('button', { name: 'Save connections' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('status')).toContainText('Connected. Selected model is available.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Crée un cours interactif sur Taylor');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Degré du polynôme' });
  await expect(slider).toHaveValue('1');
  const path = page.locator('[data-series="Polynôme de Taylor"]');
  const original = await path.getAttribute('d');
  const requestsBefore = messages.length;
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('2');
  await expect(path).not.toHaveAttribute('d', original!);
  await expect(page.locator('.teaching-outputs dd')).toHaveText('2.5');
  expect(messages).toHaveLength(requestsBefore);
  await page.getByRole('radio', { name: /1\+x/ }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.locator('.teaching-feedback')).toContainText('Correct according to this exercise');
  await expect.poll(async () => (await savedWorkspace(page)).lessonWorkspaces[FIXTURE_LESSON_ID].chat.at(-1).content).toContain('"expression":"sum(k,0,n,x^k/factorial(k))"');
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(slider).toHaveValue('1');
  expect(messages).toHaveLength(requestsBefore);
  const request = messages.at(-1) as { messages: Array<{ role: string; content: string }> };
  expect(request.messages[0].content).toContain('student-visual');
});

test('keeps visual lessons usable at320px and keyboard accessible in dark mode', async ({ page }) => {
  await page.addInitScript(answer => {
    const workspace = JSON.parse(localStorage.getItem('studentllm.workspace.v1')!);
    workspace.lessonWorkspaces[workspace.activeLessonId].chat = [{ id: 'visual-answer', role: 'assistant', content: answer }];
    localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
  }, lesson);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: /^Dark mode/ }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('slider', { name: 'Degré du polynôme' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('slider')).toHaveValue('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(568);
  const accessibility = await new AxeBuilder({ page }).include('.chat-view').analyze();
  expect(accessibility.violations.filter(violation => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([]);
});
