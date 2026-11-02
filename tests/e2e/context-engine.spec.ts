import { expect, test } from '@playwright/test';
import { TUTOR_LENGTH_REMINDER } from '../../src/prompts';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';
import { savedWorkspace } from './workspace-store';

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
  const contextPlot = { type: 'plot', title: 'Droite parametree', x: { min: 0, max: 2 }, parameters: [{ name: 'a', label: 'Pente', min: 1, max: 3, step: 1, value: 1 }], series: [{ label: 'Droite', expression: 'a*x' }] };
  const contextBrief = { id: 'v1', type: 'plot', intent: 'Tracer la droite', content: 'y=a*x, x de 0 a 2, curseur a de 1 a 3, pas 1, valeur initiale 1' };
  await page.route('**/fixture-context/v1/chat/completions', route => {
    const request = route.request().postDataJSON();
    if (request.response_format) return route.fulfill({ json: { model: 'test-context-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(contextPlot) } }] } });
    requests.push(request);
    return route.fulfill({ json: { model: 'test-context-model', choices: [{ finish_reason: 'stop', message: { content: 'Exemple illustratif avec la temperature choisie.\n\n```student-visual-request\n' + JSON.stringify(contextBrief) + '\n```' } }] } });
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
  // The length note follows the question on purpose: the question stays whole, as the last words of the learner.
  expect(messages.slice(-2)).toEqual([{ role: 'user', content: question }, { role: 'user', content: TUTOR_LENGTH_REMINDER }]);
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

test('NIM text requests omit embedded image payloads while the imported original stays intact', async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('studentllm.workspace.v1', JSON.stringify(value)), createFixtureWorkspace());
  const requests: unknown[] = [];
  const model = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  await page.route('**/nvidia-nim/v1/models', route => route.fulfill({ json: { data: [{ id: model }] } }));
  await page.route('**/nvidia-nim/v1/chat/completions', route => {
    const request = route.request().postDataJSON();
    requests.push(request);
    const content = request.messages[0].content.startsWith('# StudentLLM tutor')
      ? 'The surrounding text is available.'
      : request.messages.some((message: { content: string }) => message.content === 'Reply exactly OK.') ? 'OK' : JSON.stringify({ blocks: [] });
    return route.fulfill({ json: { model, choices: [{ finish_reason: 'stop', message: { content } }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('AI provider').selectOption('nvidia-nim');
  await page.getByRole('button', { name: 'Save connections' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('status')).toContainText(`Connected. ${model} answered the connection test.`);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const source = 'Before the figure.\n\n![VISIBLE_ALT](data:image/png;base64,' + 'QUJD'.repeat(1800) + 'BROWSERIMAGEPAYLOADMARKER)\n\nAfter the figure.';
  await page.getByLabel('Select course source').setInputFiles({ name: 'embedded-image.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
  await expect(page.getByRole('region', { name: 'Course notes document' })).toContainText('Before the figure.');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask the course chat' }).fill('Explain the text around the figure.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('The surrounding text is available.', { exact: true })).toBeVisible();
  const outbound = JSON.stringify(requests);
  expect(outbound).not.toContain('BROWSERIMAGEPAYLOADMARKER'); expect(outbound).not.toContain('QUJDQUJD');
  expect(outbound).toContain('VISIBLE_ALT'); expect(outbound).toContain('After the figure.');
  const saved = await savedWorkspace(page);
  expect(JSON.stringify(saved.lessonWorkspaces[FIXTURE_LESSON_ID].transcript)).toContain('BROWSERIMAGEPAYLOADMARKER');
  const blobIsOriginal = await page.evaluate(async expected => {
    return new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open('studentllm-sources', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('source-blobs', 'readonly').objectStore('source-blobs').getAll();
        read.onsuccess = async () => {
          const texts = await Promise.all(read.result.map((record: { blob: Blob }) => record.blob.text()));
          db.close(); resolve(texts.includes(expected));
        };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
  }, source);
  expect(blobIsOriginal).toBe(true);
});
