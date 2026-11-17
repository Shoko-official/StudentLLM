import { afterEach, beforeEach, describe, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';
import { OpenAICompatibleProvider, type ProviderGenerateOptions, type ProviderMessage } from './lib/llm-provider';
import { AI_CONNECTION_LOST_MESSAGE } from './lib/service-errors';
import { VISUAL_DECISION_PROMPT } from './prompts';

beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('composes multiple lines with Shift+Enter and sends the complete question with Enter', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(async (_messages: ProviderMessage[]) => ({ content: 'Normalization keeps softmax sensitive.', model: 'fixture-model' }));
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  expect(composer.tagName).toBe('TEXTAREA');
  await user.type(composer, 'Explain attention.');
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  await user.type(composer, 'Why normalize?');
  expect(composer).toHaveValue('Explain attention.\nWhy normalize?');
  expect(generate).not.toHaveBeenCalled();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Normalization keeps softmax sensitive.')).toBeInTheDocument();
  expect(screen.getByLabelText('Your message')).toHaveTextContent('Explain attention. Why normalize?');
  expect(generate.mock.calls[0]?.[0]).toContainEqual({ role: 'user', content: 'Explain attention.\nWhy normalize?' });
  expect(composer).toHaveValue('');
});

it('does not submit Enter while an IME composition is active', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(async () => ({ content: 'A final answer.', model: 'fixture-model' }));
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  await user.type(composer, 'Explain attention.');
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: true });
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', keyCode: 229 });
  expect(composer).toHaveValue('Explain attention.');
  expect(screen.queryByLabelText('Your message')).not.toBeInTheDocument();
  expect(generate).not.toHaveBeenCalled();
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
});

it('announces a pending answer and prevents duplicate submissions', async () => {
  const user = userEvent.setup();
  const generate = vi.fn(() => new Promise<{ content: string; model: string }>(() => {}));
  render(<App provider={{ generate }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  const composer = screen.getByRole('textbox', { name: 'Ask the course chat' });
  await user.type(composer, 'Explain attention.');
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('status', { name: 'Answer in progress' })).toHaveTextContent('Preparing an answer');
  expect(composer).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(generate).toHaveBeenCalledTimes(1);
});

describe('a streamed answer', () => {
  const requestFence = '```student-visual-request\n' + JSON.stringify({ id: 'v1', type: 'quiz', intent: 'Check the idea', content: 'Ask about pressure' }, null, 1) + '\n```';
  const quiz = JSON.stringify({ type: 'quiz', title: 'Check', question: 'Why?', options: ['A', 'B'], answer: 1, explanation: 'B follows.' });
  const pause = (ms = 70) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  function streamingProvider(laterCalls: (options: ProviderGenerateOptions) => string = () => '{"visual":false}') {
    let onText: (text: string) => void = () => undefined;
    let finish: (content: string) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const generate = vi.fn((_messages: ProviderMessage[], options: ProviderGenerateOptions = {}) => {
      if (options.responseFormat) return Promise.resolve({ content: laterCalls(options), model: 'fixture-model' });
      onText = options.onText ?? onText;
      return new Promise<{ content: string; model: string }>((resolve, reject) => {
        finish = (content) => resolve({ content, model: 'fixture-model' });
        fail = reject;
      });
    });
    return { provider: { generate, supportsStructuredOutputs: true }, generate, write: (text: string) => onText(text), finish: (content: string) => finish(content), fail: (error: Error) => fail(error) };
  }

  async function ask(provider: { generate: ReturnType<typeof vi.fn>; supportsStructuredOutputs: boolean }, question = 'Explain pressure.') {
    const user = userEvent.setup();
    render(<App provider={provider as never} />);
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), question);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(provider.generate).toHaveBeenCalled());
    return user;
  }

  const assistantMessages = () => screen.queryAllByRole('article', { name: 'Course assistant response' });

  it('shows the text before the answer ends and replaces it in one update with a single final message', async () => {
    const { provider, generate, write, finish } = streamingProvider();
    await ask(provider);
    expect(generate.mock.calls[0][1]?.onText).toEqual(expect.any(Function));
    expect(screen.getByRole('status', { name: 'Answer in progress' })).toHaveTextContent('Preparing an answer');
    write('Pressure is');
    expect(await screen.findByText('Pressure is')).toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(1);
    expect(assistantMessages()[0]).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toBeDisabled();
    write('Pressure is force over area.');
    expect(await screen.findByText('Pressure is force over area.')).toBeInTheDocument();

    const counts: number[] = [];
    const observer = new MutationObserver(() => counts.push(assistantMessages().length));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    finish('Pressure is force over area, in pascals.');
    await pause();
    observer.disconnect();
    expect(counts.length).toBeGreaterThan(0);
    expect(new Set(counts)).toEqual(new Set([1]));
    expect(assistantMessages()).toHaveLength(1);
    expect(assistantMessages()[0]).toHaveTextContent('Pressure is force over area, in pascals.');
    expect(assistantMessages()[0]).not.toHaveAttribute('aria-busy');
    expect(screen.queryByRole('status', { name: 'Answer in progress' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toBeEnabled();
  });

  it('never renders the raw request or visual, at any step of the answer', async () => {
    const answer = `First part.\n\n${requestFence}\n\nSecond part.\n\n~~~~student-visual\n${quiz}\n~~~~\n\nThird part.`;
    const { provider, write, finish } = streamingProvider();
    await ask(provider);
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(document.querySelector('.chat-list')?.textContent ?? ''));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const step = Math.ceil(answer.length / 24);
    for (let end = step; end < answer.length; end += step) {
      write(answer.slice(0, end));
      await pause();
      seen.push(document.querySelector('.chat-list')?.textContent ?? '');
    }
    observer.disconnect();
    expect(seen.at(-1)).toContain('Second part.');
    for (const text of seen) expect(text).not.toMatch(/student-visual|Check the idea|Ask about pressure|"id"|Why\?|B follows|```|~~~/);
    finish(answer);
    expect(await screen.findByText('Third part.')).toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(1);
  });

  it('keeps at most one update per interval and the latest text', async () => {
    const { provider, write } = streamingProvider();
    await ask(provider);
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const text = assistantMessages()[0]?.querySelector('.message-content')?.textContent;
      if (text) seen.push(text);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    for (let n = 1; n <= 30; n++) write(`Word ${n}`);
    await pause();
    observer.disconnect();
    expect(new Set(seen)).toEqual(new Set(['Word 30']));
  });

  it('flushes nothing after the answer has ended', async () => {
    const { provider, write, finish } = streamingProvider();
    await ask(provider);
    write('Late partial text');
    finish('Complete answer.');
    expect(await screen.findByText('Complete answer.')).toBeInTheDocument();
    await pause();
    expect(screen.queryByText('Late partial text')).not.toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(1);
  });

  it('removes the partial text on failure, returns the question and saves nothing partial', async () => {
    const { provider, write, fail } = streamingProvider();
    await ask(provider, 'Explain pressure.');
    write('Partial explanation');
    expect(await screen.findByText('Partial explanation')).toBeInTheDocument();
    fail(new Error('Provider request failed: engine fell over'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await pause();
    expect(screen.queryByText('Partial explanation')).not.toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(0);
    expect(screen.queryByLabelText('Your message')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toHaveValue('Explain pressure.');
    await waitFor(() => expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Explain pressure.'));
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Partial explanation');
  });

  it('never saves the partial text while the answer is arriving', async () => {
    const { provider, write, finish } = streamingProvider();
    await ask(provider);
    write('Partial explanation');
    expect(await screen.findByText('Partial explanation')).toBeInTheDocument();
    await pause(150);
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Partial explanation');
    finish('Complete answer.');
    await waitFor(() => expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('Complete answer.'));
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Partial explanation');
  });

  it('shows the text only in the course it belongs to', async () => {
    const { provider, write, finish } = streamingProvider();
    const user = await ask(provider);
    write('Partial explanation');
    expect(await screen.findByText('Partial explanation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Self-attention and Context' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Self-attention and Context'));
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Answer in progress' })).toHaveTextContent('Preparing an answer');
    expect(screen.queryByText('Partial explanation')).not.toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(0);
    write('Partial explanation goes on');
    await pause();
    expect(screen.queryByText('Partial explanation goes on')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Attention & Scaled Dot-Product' }));
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(await screen.findByText('Partial explanation goes on')).toBeInTheDocument();
    finish('Complete answer.');
    expect(await screen.findByText('Complete answer.')).toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(1);
  });

  it('keeps a failed answer of another course out of the course being read', async () => {
    const { provider, write, fail } = streamingProvider();
    const user = await ask(provider);
    write('Partial explanation');
    expect(await screen.findByText('Partial explanation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Self-attention and Context' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Self-attention and Context'));
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    fail(new Error('Provider request failed: engine fell over'));
    await pause();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Attention & Scaled Dot-Product' }));
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Partial explanation')).not.toBeInTheDocument();
  });

  it('still starts the visual jobs of the complete text', async () => {
    const { provider, generate, write, finish } = streamingProvider(() => quiz);
    await ask(provider);
    write('Prose first.');
    expect(await screen.findByText('Prose first.')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
    finish(`Prose first.\n\n${requestFence}`);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][1]).toMatchObject({ responseFormat: expect.anything() });
    expect(generate.mock.calls[1][1]?.onText).toBeUndefined();
    expect(await screen.findByRole('radio', { name: 'B' })).toBeInTheDocument();
  });

  it('still asks the decision call when the complete text has no visual', async () => {
    const { provider, generate, write, finish } = streamingProvider();
    await ask(provider);
    write('Prose only.');
    expect(await screen.findByText('Prose only.')).toBeInTheDocument();
    finish('Prose only.');
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][0][0].content).toBe(VISUAL_DECISION_PROMPT);
    expect(generate.mock.calls[1][1]?.onText).toBeUndefined();
  });

  it('works with a server that ignores the stream flag and answers JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).endsWith('/chat/completions')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const stream = JSON.parse(String(init?.body)).stream;
      return new Response(JSON.stringify({ model: 'json-model', choices: [{ message: { content: stream ? 'A JSON answer.' : '{"visual":false}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const user = userEvent.setup();
    render(<App provider={new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', fetchImpl: fetchMock as typeof fetch })} />);
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explain pressure.');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('A JSON answer.')).toBeInTheDocument();
    await pause();
    expect(assistantMessages()).toHaveLength(1);
    expect(screen.getByText('LM Studio · json-model')).toBeInTheDocument();
  });

  it.each([
    ['local', false, AI_CONNECTION_LOST_MESSAGE],
    ['cloud', true, 'The NVIDIA model is not answering right now. Try another model in Settings.'],
  ])('turns a %s stream cut after its headers into the helpful message, with no partial and the question back', async (_label, cloud, expected) => {
    if (cloud) localStorage.setItem('studentllm.services.v1', JSON.stringify({ llmProvider: 'nvidia-nim' }));
    const encoder = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const user = userEvent.setup();
    render(<App provider={new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', fetchImpl: fetchMock })} />);
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explain pressure.');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(upstream).toBeDefined());
    upstream.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial explanation' } }] })}\n\n`));
    expect(await screen.findByText('Partial explanation')).toBeInTheDocument();
    upstream.error(new TypeError('network error'));
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.getByRole('alert')).not.toHaveTextContent('network error');
    expect(screen.queryByText('Partial explanation')).not.toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toHaveValue('Explain pressure.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a stream that ends with no end signal as cut: nothing saved and the question back', async () => {
    const encoder = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const user = userEvent.setup();
    render(<App provider={new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', fetchImpl: fetchMock })} />);
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explain pressure.');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(upstream).toBeDefined());
    upstream.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial explanation' } }] })}\n\n`));
    expect(await screen.findByText('Partial explanation')).toBeInTheDocument();
    upstream.close();
    expect(await screen.findByRole('alert')).toHaveTextContent(AI_CONNECTION_LOST_MESSAGE);
    expect(screen.queryByText('Partial explanation')).not.toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(0);
    expect(screen.queryByLabelText('Your message')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toHaveValue('Explain pressure.');
    expect(screen.getByRole('textbox', { name: 'Ask the course chat' })).toBeEnabled();
    await waitFor(() => expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Explain pressure.'));
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Partial explanation');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams end to end through the provider from server-sent events', async () => {
    const encoder = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (!JSON.parse(String(init?.body)).stream) return new Response(JSON.stringify({ choices: [{ message: { content: '{"visual":false}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const send = (content: string) => upstream.enqueue(encoder.encode(`data: ${JSON.stringify({ model: 'sse-model', choices: [{ delta: { content } }] })}\n\n`));
    const user = userEvent.setup();
    render(<App provider={new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', fetchImpl: fetchMock as typeof fetch })} />);
    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explain pressure.');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(upstream).toBeDefined());
    send('<think>hidden</think>Word by');
    expect(await screen.findByText('Word by')).toBeInTheDocument();
    send(' word.');
    expect(await screen.findByText('Word by word.')).toBeInTheDocument();
    upstream.enqueue(encoder.encode('data: [DONE]\n\n'));
    expect(await screen.findByText('LM Studio · sse-model')).toBeInTheDocument();
    expect(assistantMessages()).toHaveLength(1);
    expect(assistantMessages()[0]).not.toHaveAttribute('aria-busy');
  });
});

it('labels a cloud answer with the selected provider instead of LM Studio', async () => {
  localStorage.setItem('studentllm.services.v1', JSON.stringify({ llmProvider: 'nvidia-nim' }));
  const user = userEvent.setup();
  render(<App provider={{ generate: vi.fn(async () => ({ content: 'A cloud answer.', model: 'fixture-cloud-model' })) }} />);
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  await user.type(screen.getByRole('textbox', { name: 'Ask the course chat' }), 'Explain attention.');
  await user.keyboard('{Enter}');
  expect(await screen.findByText('NVIDIA NIM · fixture-cloud-model')).toBeInTheDocument();
});
