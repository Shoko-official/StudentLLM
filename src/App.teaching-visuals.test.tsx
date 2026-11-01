import { afterEach, beforeEach, describe, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';
import type { ProviderMessage } from './lib/llm-provider';
import { MAX_AUTOMATIC_VISUALS } from './lib/visual-brief';

beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const plotBrief = { id: 'v1', type: 'plot', intent: 'Compare the curves', content: 'y=x^2 from -2 to 2 with a slider a', parameters: ['a'] };
const plotVisual = { type: 'plot', title: 'Parabole', x: { min: -2, max: 2 }, parameters: [{ name: 'a', label: 'Coefficient', min: 0, max: 4, step: 1, value: 2 }], series: [{ label: 'Courbe', expression: 'a*x^2' }] };
const requestFence = (brief: object) => '```student-visual-request\n' + JSON.stringify(brief) + '\n```';
const tutorReply = '# Comprendre\n\nModifie le coefficient.\n\n' + requestFence(plotBrief) + '\n\nObserve la courbe.';
const isVisualCall = (options?: { responseFormat?: unknown }) => Boolean(options?.responseFormat);

it('shows the prose first, then replaces the request with the finished interactive visual', async () => {
  const user = userEvent.setup();
  let release: (value: { content: string; model: string }) => void = () => undefined;
  const generate = vi.fn((_messages: ProviderMessage[], options?: { responseFormat?: unknown }) => isVisualCall(options)
    ? new Promise<{ content: string; model: string }>((resolve) => { release = resolve; })
    : Promise.resolve({ content: tutorReply, model: 'test-model' }));
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explique la parabole');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  expect(await screen.findByText('Modifie le coefficient.')).toBeInTheDocument();
  expect(await screen.findByText('Preparing a visual: Compare the curves')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toBeEnabled();
  const system = generate.mock.calls[0][0][0].content;
  expect(system).toContain('student-visual-request');
  expect(system).toContain('Do not refuse a general educational request');
  expect(generate.mock.calls[0][1]).not.toHaveProperty('responseFormat');
  release({ content: JSON.stringify(plotVisual), model: 'test-model' });
  expect(await screen.findByRole('slider', { name: /Coefficient/ })).toHaveValue('2');
  await waitFor(() => expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('"title\\":\\"Parabole'));
  expect(generate).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('student-visual-request');
});

it('keeps the explanation and offers a retry when a visual fails, then repairs it on demand', async () => {
  const user = userEvent.setup();
  const replies = [tutorReply, '{"bad":', '{"bad":', JSON.stringify(plotVisual)];
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: replies.shift()!, model: 'test-model' }));
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explique la parabole');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  await user.click(await screen.findByRole('button', { name: 'Retry this visual' }));
  expect(screen.getByText('Modifie le coefficient.')).toBeInTheDocument();
  expect(await screen.findByRole('slider', { name: /Coefficient/ })).toHaveValue('2');
  expect(generate).toHaveBeenCalledTimes(4);
});

it('starts at most the automatic limit of visuals from one reply and leaves the rest retryable', async () => {
  const user = userEvent.setup();
  const requests = Array.from({ length: MAX_AUTOMATIC_VISUALS + 2 }, (_, index) => requestFence({ ...plotBrief, id: `v${index + 1}`, intent: `Curve ${index + 1}` }));
  const reply = 'Voici plusieurs courbes.\n\n' + requests.join('\n\n');
  const generate = vi.fn(async (_messages: ProviderMessage[], options?: { responseFormat?: unknown }) => ({ content: isVisualCall(options) ? JSON.stringify(plotVisual) : reply, model: 'test-model' }));
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Montre beaucoup de courbes');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  await waitFor(() => expect(screen.getAllByRole('slider')).toHaveLength(MAX_AUTOMATIC_VISUALS));
  expect(screen.getAllByRole('button', { name: 'Retry this visual' })).toHaveLength(2);
  expect(generate).toHaveBeenCalledTimes(1 + MAX_AUTOMATIC_VISUALS);
});

it('renders a pending request from a previous session as retryable, with no automatic call', async () => {
  const workspace = createFixtureWorkspace();
  workspace.lessonWorkspaces![workspace.activeLessonId].chat = [{ id: 'old', role: 'assistant', content: tutorReply }];
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: JSON.stringify(plotVisual), model: 'test-model' }));
  const user = userEvent.setup();
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  expect(await screen.findByRole('button', { name: 'Retry this visual' })).toBeInTheDocument();
  expect(generate).not.toHaveBeenCalled();
});

it('returns the question to the composer when the tutor gives no answer', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(async () => ({ content: '   ', model: 'test-model' }));
  render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  await user.type(composer, 'Crée une visualisation');
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The model returned no answer');
  expect(composer).toHaveValue('Crée une visualisation');
  expect(generate).toHaveBeenCalledTimes(1);
});

it('keeps a user-pasted visual specification as code rather than a second interactive answer', async () => {
  const user = userEvent.setup();
  const workspace = createFixtureWorkspace();
  const lesson = workspace.lessonWorkspaces![workspace.activeLessonId];
  lesson.chat = [{ id: 'pasted-code', role: 'user', content: '```student-visual\n{"type":"quiz","title":"Pasted","question":"Q?","options":["A","B"],"answer":0,"explanation":"A"}\n```' }];
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  render(<App provider={null} />);
  await user.click(screen.getByRole('tab', { name: /^Chat$/ }));
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByLabelText('Your message').querySelector('code.language-student-visual')).toBeInTheDocument();
});

describe('visual jobs in the app', () => {
  const manyRequests = (count: number) => 'Voici des courbes.\n\n' + Array.from({ length: count }, (_, index) => requestFence({ ...plotBrief, id: `v${index + 1}`, intent: `Curve ${index + 1}` })).join('\n\n');
  const seedChat = (content: string) => {
    const workspace = createFixtureWorkspace();
    workspace.lessonWorkspaces![workspace.activeLessonId].chat = [{ id: 'old', role: 'assistant', content }];
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  };
  /** Visual calls stay open until released and reject when their signal aborts. */
  function gatedVisuals(prose: string) {
    const open: Array<{ signal: AbortSignal; release: () => void }> = [];
    let inFlight = 0, peak = 0, total = 0;
    const generate = vi.fn((_messages: ProviderMessage[], options?: { responseFormat?: unknown; signal?: AbortSignal }) => {
      if (!isVisualCall(options)) return Promise.resolve({ content: prose, model: 'test-model' });
      total++; inFlight++; peak = Math.max(peak, inFlight);
      return new Promise<{ content: string; model: string }>((resolve, reject) => {
        const done = () => { inFlight--; };
        options?.signal?.addEventListener('abort', () => { done(); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
        open.push({ signal: options!.signal!, release: () => { done(); resolve({ content: JSON.stringify(plotVisual), model: 'test-model' }); } });
      });
    });
    return { generate, open, peak: () => peak, total: () => total };
  }
  const openChat = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('tab', { name: /^Chat$/ }));

  it('keeps at most two visual calls in flight across three retry clicks, and finishes all of them', async () => {
    seedChat(manyRequests(3));
    const user = userEvent.setup();
    const { generate, open, peak, total } = gatedVisuals('');
    render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
    await openChat(user);
    for (let click = 0; click < 3; click++) await user.click(screen.getAllByRole('button', { name: 'Retry this visual' })[0]);
    await waitFor(() => expect(total()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(total()).toBe(2);
    let released = 0;
    await waitFor(() => {
      while (released < open.length) open[released++].release();
      expect(screen.getAllByRole('slider')).toHaveLength(3);
    });
    expect(peak()).toBe(2);
    expect(total()).toBe(3);
  });

  it('gives each visual attempt the NIM deadline, and none otherwise', async () => {
    const delays = () => (setTimeout as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]);
    const run = async (nim: boolean) => {
      localStorage.clear();
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
      if (nim) localStorage.setItem('studentllm.services.v1', JSON.stringify({ llmProvider: 'nvidia-nim' }));
      vi.spyOn(globalThis, 'setTimeout');
      const generate = vi.fn(async (_messages: ProviderMessage[], options?: { responseFormat?: unknown }) => ({ content: isVisualCall(options) ? JSON.stringify(plotVisual) : tutorReply, model: 'test-model' }));
      const user = userEvent.setup();
      const view = render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
      await openChat(user);
      await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explique la parabole');
      await user.click(screen.getByRole('button', { name: /^Send$/ }));
      expect(await screen.findByRole('slider', { name: /Coefficient/ })).toBeInTheDocument();
      const used = delays();
      view.unmount();
      vi.restoreAllMocks();
      return used;
    };
    expect(await run(true)).toContain(60_000);
    expect(await run(false)).not.toContain(60_000);
  });

  it('writes a finished visual to the course that asked for it after the student switches course', async () => {
    const user = userEvent.setup();
    let releaseProse: () => void = () => undefined;
    const visuals = gatedVisuals('');
    const generate = vi.fn((messages: ProviderMessage[], options?: { responseFormat?: unknown; signal?: AbortSignal }) => isVisualCall(options)
      ? visuals.generate(messages, options)
      : new Promise<{ content: string; model: string }>((resolve) => { releaseProse = () => resolve({ content: tutorReply, model: 'test-model' }); }));
    render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
    await openChat(user);
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explique la parabole');
    await user.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Self-attention and Context' }));
    await act(async () => releaseProse());
    await waitFor(() => expect(visuals.open).toHaveLength(1));
    await act(async () => visuals.open[0].release());
    const saved = () => JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!).lessonWorkspaces as Record<string, { chat: Array<{ role: string; content: string }> }>;
    await waitFor(() => expect(saved()['fixture-attention'].chat.find((message) => message.role === 'assistant')?.content).toContain('"title":"Parabole"'));
    expect(saved()['fixture-attention'].chat.find((message) => message.role === 'assistant')?.content).not.toContain('student-visual-request');
    expect(saved()['fixture-context']?.chat ?? []).toEqual([]);
  });

  it('starts no visual call when the course is deleted while its answer is being written', async () => {
    seedChat('Earlier answer.');
    const user = userEvent.setup();
    let release: (content: string) => void = () => undefined;
    const generate = vi.fn(() => new Promise<{ content: string; model: string }>((resolve) => { release = (content) => resolve({ content, model: 'fixture' }); }));
    render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
    await openChat(user);
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explique la parabole');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText('More'));
    await user.click(screen.getByRole('button', { name: /Delete course$/ }));
    await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
    release(manyRequests(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('stops the visual calls of a course when it is deleted', async () => {
    seedChat(manyRequests(3));
    const user = userEvent.setup();
    const { generate, open, total } = gatedVisuals('');
    render(<App provider={{ generate, supportsStructuredOutputs: true }} />);
    await openChat(user);
    for (let click = 0; click < 3; click++) await user.click(screen.getAllByRole('button', { name: 'Retry this visual' })[0]);
    await waitFor(() => expect(total()).toBe(2));
    await user.click(screen.getByText('More'));
    await user.click(screen.getByRole('button', { name: /Delete course$/ }));
    await user.click(screen.getByRole('button', { name: 'Delete course permanently' }));
    await waitFor(() => expect(open.every((call) => call.signal.aborted)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(total()).toBe(2);
  });
});
