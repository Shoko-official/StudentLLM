import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace, FIXTURE_LESSON_ID } from './test/workspace-fixture';
import type { DocumentExtraction } from './lib/document-engine';
import type { NimDocumentEngineOptions } from './lib/nim-document-engine';
import type { SourceBlobStore } from './lib/source-storage';

const vision = vi.hoisted(() => ({ extract: vi.fn(), options: null as NimDocumentEngineOptions | null }));
vi.mock('./lib/nim-document-engine', () => ({ NimDocumentEngine: class {
  constructor(options: NimDocumentEngineOptions) { vision.options = options; }
  extract(blob: Blob) { return vision.extract(blob); }
} }));
const extracted = (text = '# Vision evidence\n\nSources → Notes'): DocumentExtraction => ({ model: 'fixture-vision', pages: [{ pageNumber: 1, text, blocks: [{ x: 0, y: 0, width: 0, height: 0, kind: 'markdown', text }] }] });
const original = new File(['%PDF synthetic original'], 'diagram.pdf', { type: 'application/pdf' });
const store = (): SourceBlobStore => {
  const files = new Map<string, Blob>([['fixture-pdf', original]]);
  return { durability: 'memory-only', save: vi.fn(async (id, blob) => { files.set(id, blob); }), load: vi.fn(async id => files.get(id) ?? null), remove: vi.fn(async id => { files.delete(id); }) };
};
const saved = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear(); sessionStorage.clear();
  const fixture = createFixtureWorkspace();
  fixture.resources.push({ id: 'fixture-pdf', name: original.name, kind: 'document', mimeType: original.type, meta: 'Saved original' });
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fixture));
  vision.extract.mockReset().mockResolvedValue(extracted()); vision.options = null;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('keeps extraction local unless the named source action and consent are both chosen', async () => {
  const user = userEvent.setup();
  render(<App provider={null} documentEngine={null} sourceBlobStore={store()} />);
  expect(vision.extract).not.toHaveBeenCalled();
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  vi.mocked(window.confirm).mockReturnValue(false);
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/diagram\.pdf.*images.*NVIDIA/s));
  expect(vision.extract).not.toHaveBeenCalled();
});

it('merges a reviewed vision transcription into the same course and preserves it across reload', async () => {
  const user = userEvent.setup();
  const blobStore = store();
  const view = render(<App provider={null} documentEngine={null} sourceBlobStore={blobStore} />);
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  await waitFor(() => expect(vision.extract).toHaveBeenCalledTimes(1));
  expect(vision.options?.consent).toBe(true);
  await user.click(screen.getByRole('tab', { name: 'Notes' }));
  await screen.findByRole('heading', { name: 'Vision evidence' });
  expect(screen.getByRole('region', { name: 'Course notes document' })).toHaveTextContent('The square-root factor');
  await waitFor(() => expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((s: { text: string; status: string }) => s.text.includes('Vision evidence') && s.status === 'review')).toBe(true));
  expect(saved().lessons).toHaveLength(3);
  expect(saved().activeLessonId).toBe(FIXTURE_LESSON_ID);
  view.unmount();
  render(<App provider={null} documentEngine={null} sourceBlobStore={blobStore} />);
  await screen.findByRole('heading', { name: 'Vision evidence' });
  expect(vision.extract).toHaveBeenCalledTimes(1);
});

it('pins the source destination while another course is open', async () => {
  let finish!: (value: DocumentExtraction) => void;
  vision.extract.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup();
  render(<App provider={null} documentEngine={null} sourceBlobStore={store()} />);
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  await waitFor(() => expect(vision.extract).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: 'Self-attention and Context' }));
  await act(async () => { finish(extracted()); });
  await waitFor(() => expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((s: { text: string }) => s.text.includes('Vision evidence'))).toBe(true));
  expect(saved().lessonWorkspaces['fixture-context'].transcript).toHaveLength(0);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Self-attention and Context');
});

it('discards late results after cancellation', async () => {
  let finish!: (value: DocumentExtraction) => void;
  vision.extract.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup();
  render(<App provider={null} documentEngine={null} sourceBlobStore={store()} />);
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  await waitFor(() => expect(vision.extract).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: 'Cancel NVIDIA analysis' }));
  expect(vision.options?.signal?.aborted).toBe(true);
  await act(async () => { finish(extracted()); });
  expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((s: { text: string }) => s.text.includes('Vision evidence'))).toBe(false);
});

it('retains the original and old notes when NVIDIA rejects the request', async () => {
  vision.extract.mockRejectedValue(new Error('NVIDIA request limit reached.'));
  const user = userEvent.setup(); const blobStore = store();
  render(<App provider={null} documentEngine={null} sourceBlobStore={blobStore} />);
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  await screen.findByText(/NVIDIA request limit reached/);
  expect(blobStore.remove).not.toHaveBeenCalled();
  expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].resources.some((r: { id: string }) => r.id === 'fixture-pdf')).toBe(true);
});

it('keeps explicit vision notes when an older background local extraction finishes later', async () => {
  let finishLocal!: (value: DocumentExtraction) => void;
  const extract = vi.fn(() => new Promise<DocumentExtraction>(resolve => { finishLocal = resolve; }));
  const user = userEvent.setup();
  render(<App provider={null} documentEngine={{ extract }} sourceBlobStore={store()} />);
  await waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  await waitFor(() => expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((s: { text: string }) => s.text.includes('Vision evidence'))).toBe(true));
  await act(async () => { finishLocal(extracted('Stale local extraction')); });
  await user.click(screen.getByRole('tab', { name: 'Notes' }));
  await screen.findByRole('heading', { name: 'Vision evidence' });
  expect(screen.getByRole('region', { name: 'Course notes document' })).not.toHaveTextContent('Stale local extraction');
});

it('does not let the initial import extraction replace a faster explicit vision result', async () => {
  const fixture = createFixtureWorkspace();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fixture));
  let finishLocal!: (value: DocumentExtraction) => void;
  const extract = vi.fn(() => new Promise<DocumentExtraction>(resolve => { finishLocal = resolve; }));
  const user = userEvent.setup();
  render(<App provider={null} documentEngine={{ extract }} sourceBlobStore={store()} />);
  await user.upload(screen.getByLabelText('Select course source'), original);
  await waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('tab', { name: /^Sources/ }));
  await user.click(screen.getByRole('button', { name: 'Analyze diagram.pdf with NVIDIA' }));
  await waitFor(() => expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.some((s: { text: string }) => s.text.includes('Vision evidence'))).toBe(true));
  await act(async () => { finishLocal(extracted('Stale initial import')); });
  await user.click(screen.getByRole('tab', { name: 'Notes' }));
  await screen.findByRole('heading', { name: 'Vision evidence' });
  expect(screen.getByRole('region', { name: 'Course notes document' })).not.toHaveTextContent('Stale initial import');
  expect(saved().lessonWorkspaces[FIXTURE_LESSON_ID].transcript.filter((s: { sourceId?: string }) => s.sourceId)).toHaveLength(1);
});
