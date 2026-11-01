import { expect, test } from '@playwright/test';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from '../../src/test/workspace-fixture';
import { savedWorkspace } from './workspace-store';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function twoPagePdf() {
  const stream = '0.2 0.5 0.8 rg 20 20 200 140 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources <<>> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources <<>> /Contents 6 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let data = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const offset = data.length; data += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(workspace => {
    if (!localStorage.getItem('studentllm.workspace.v1')) localStorage.setItem('studentllm.workspace.v1', JSON.stringify(workspace));
  }, createFixtureWorkspace());
  await page.route('**/extract', route => route.fulfill({ json: { model: 'fixture-local', pages: [{ pageNumber: 1, text: 'Local printed evidence.', blocks: [] }] } }));
});

test('image analysis stays local until explicit consent, preserves Markdown and survives reload', async ({ page }) => {
  const requests: Record<string, any>[] = [];
  await page.route('**/nvidia-nim/v1/chat/completions', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: '# Vision evidence\n\n| Source | Destination |\n|---|---|\n| Image | Notes |\n\n$$x^2 + 1$$' } }] } });
  });
  await page.goto('/');
  await page.getByLabel('Select course source').setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByRole('region', { name: 'Course notes document' })).toContainText('Local printed evidence.');
  expect(requests).toHaveLength(0);
  await page.getByRole('tab', { name: /^Sources/ }).click();
  const analyze = page.getByRole('button', { name: 'Analyze diagram.png with NVIDIA' });
  page.once('dialog', dialog => dialog.dismiss());
  await analyze.click();
  expect(requests).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Page images'); return dialog.accept(); });
  await analyze.click();
  await expect(analyze).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', stream: false, chat_template_kwargs: { enable_thinking: false } });
  expect(requests[0].messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vision evidence', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Destination');
  const saved = await savedWorkspace(page);
  expect(saved.lessons).toHaveLength(3);
  expect(saved.lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((item: { text: string; status: string }) => item.text.includes('Vision evidence') && item.status === 'review')).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vision evidence', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show or hide navigation' }).click();
  await page.getByRole('tab', { name: /^Sources/ }).click();
  await expect(analyze).toBeVisible();
  const bounds = await analyze.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
});

test('real PDF rendering sends one bounded page image at a time and keeps both page citations', async ({ page }) => {
  let count = 0;
  await page.route('**/nvidia-nim/v1/chat/completions', async route => {
    count += 1;
    expect(route.request().postDataJSON().messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: `# Vision page ${count}\n\nSynthetic document page ${count}.` } }] } });
  });
  await page.goto('/');
  await page.getByLabel('Select course source').setInputFiles({ name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: twoPagePdf() });
  await expect(page.getByRole('region', { name: 'Course notes document' })).toContainText('Local printed evidence.');
  await page.getByRole('tab', { name: /^Sources/ }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Analyze two-pages.pdf with NVIDIA' }).click();
  await expect.poll(() => count).toBe(2);
  await expect(page.getByRole('button', { name: 'Analyze two-pages.pdf with NVIDIA' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vision page 1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vision page 2', exact: true })).toBeVisible();
  const saved = await savedWorkspace(page);
  expect(saved.lessonWorkspaces[FIXTURE_LESSON_ID].transcript.filter((segment: { text: string }) => segment.text.includes('Synthetic document page')).map((segment: { timestamp: string }) => segment.timestamp)).toEqual(['Page 1', 'Page 2']);
});
