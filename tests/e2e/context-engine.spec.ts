import { expect, test } from '@playwright/test';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';

test('full context retains later sources and exact dialogue while generated plots remain interactive', async ({ page }) => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].transcript = Array.from({ length: 24 }, (_, index) => ({ id: `source-${index}`, timestamp: `00:${index}`, speaker: 'Teacher', text: `COURSE_MARKER_${index}: chapter ${index}.` }));
  workspace.lessonWorkspaces![FIXTURE_LESSON_ID].chat = [
    { id: 'prior-user', role: 'user', content: 'Pour cette discussion, garde la temperature a 275 K.' },
    { id: 'prior-assistant', role: 'assistant', content: 'Temperature choisie : 275 K.' },
  ];
  await page.addInitScript(value => localStorage.setItem('studentllm.workspace.v1', JSON.stringify(value)), workspace);
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let embeddingCalls = 0;
  await page.route('**/fixture-context/v1/models', route => route.fulfill({ json: { data: [{ id: 'test-context-model' }] } }));
  await page.route('**/fixture-context/v1/embeddings', route => { embeddingCalls++; return route.fulfill({ status: 503 }); });
  await page.route('**/fixture-context/v1/chat/completions', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { model: 'test-context-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sections: [{ markdown: 'Exemple illustratif avec la temperature choisie.', visual: { type: 'plot', title: 'Droite parametree', x: { min: 0, max: 2 }, parameters: [{ name: 'a', label: 'Pente', min: 1, max: 3, step: 1, value: 1 }], series: [{ label: 'Droite', expression: 'a*x' }] } }] }) } }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Context window (tokens)', { exact: true })).toBeVisible();
  await page.getByLabel('LM Studio address').fill('/fixture-context/v1');
  await page.getByLabel('Model', { exact: true }).fill('test-context-model');
  await page.getByRole('button', { name: 'Save connections' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('status')).toContainText('Connected. Selected model is available.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const question = 'Dans ce cours, reprends les memes hypotheses et trace un exemple.';
  await page.getByRole('textbox', { name: 'Ask the course chat' }).fill(question);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Pente' });
  await expect(slider).toHaveValue('1');
  expect(requests).toHaveLength(1);
  const messages = requests[0].messages;
  expect(messages.at(-1)).toEqual({ role: 'user', content: question });
  expect(messages).toContainEqual({ role: 'user', content: 'Pour cette discussion, garde la temperature a 275 K.' });
  expect(messages).toContainEqual({ role: 'assistant', content: 'Temperature choisie : 275 K.' });
  expect(messages[0].content).not.toContain('COURSE_MARKER_');
  const data = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  expect(data).toContain('COURSE_MARKER_0'); expect(data).toContain('COURSE_MARKER_23');
  expect(embeddingCalls).toBe(0);
  await expect(page.getByLabel('Response context')).toContainText('All available course text provided');
  await slider.focus(); await slider.press('ArrowRight');
  await expect(slider).toHaveValue('2');
  expect(requests).toHaveLength(1);
});
