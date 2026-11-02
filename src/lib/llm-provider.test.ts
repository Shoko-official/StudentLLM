import { describe, expect, it, vi } from 'vitest';
import { createLocalLLMProvider, OpenAICompatibleProvider } from './llm-provider';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('OpenAI-compatible LLM provider', () => {
  it('includes a thinking preference only when explicitly configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ choices: [{ message: { content: 'OK' } }] }));
    const configured = new OpenAICompatibleProvider({ baseUrl: '/nvidia-nim/v1', model: 'fixture-model', fetchImpl, chatTemplateKwargs: { enable_thinking: false } });
    await configured.generate([{ role: 'user', content: 'Hello' }]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toHaveProperty('chat_template_kwargs.enable_thinking', false);
    const local = new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', fetchImpl });
    await local.generate([{ role: 'user', content: 'Hello' }]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).not.toHaveProperty('chat_template_kwargs');
  });
  it('sends a local chat request and extracts the assistant answer', async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response({
      model: 'qwen/qwen3-4b',
      choices: [{ message: { content: 'The answer is grounded in the supplied context.' } }],
    }));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1/',
      model: 'qwen/qwen3-4b',
      fetchImpl,
    });

    const result = await provider.generate([
      { role: 'system', content: 'Use the course context.' },
      { role: 'user', content: 'Explain the concept.' },
    ]);

    expect(result).toEqual({ model: 'qwen/qwen3-4b', content: 'The answer is grounded in the supplied context.' });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
    const request = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(request[1]?.body as string)).toMatchObject({
      model: 'qwen/qwen3-4b',
      temperature: 0,
      stream: false,
    });
  });

  it('binds the default fetch implementation to its global context', async () => {
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error('fetch context was lost');
      return Promise.resolve(response({
        model: 'qwen/qwen3-4b',
        choices: [{ message: { content: 'Bound fetch works.' } }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'qwen/qwen3-4b',
      });

      await expect(provider.generate([{ role: 'user', content: 'Hello' }])).resolves.toMatchObject({ content: 'Bound fetch works.' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns no provider when no local endpoint is configured', () => {
    expect(createLocalLLMProvider({})).toBeNull();
  });

  it('uses the same-origin development proxy by default', () => {
    expect(createLocalLLMProvider({ MODE: 'development' })).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('passes a caller-provided JSON schema to OpenAI-compatible providers', async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response({
      model: 'openai/gpt-oss-20b',
      choices: [{ message: { content: '{"ok":true}' } }],
    }));
    const provider = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'openai/gpt-oss-20b', fetchImpl });
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'test_response',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    };

    await provider.generate([{ role: 'user', content: 'Return JSON.' }], { responseFormat });

    const sent = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(sent.response_format).toEqual(responseFormat);
  });

  it('prefers GPT OSS for a fresh local development connection', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      model: 'openai/gpt-oss-20b',
      choices: [{ message: { content: 'Connected.' } }],
    }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const provider = createLocalLLMProvider({ MODE: 'development' });
      await expect(provider?.generate([{ role: 'user', content: 'Hello' }])).resolves.toMatchObject({ model: 'openai/gpt-oss-20b' });
      expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).model).toBe('openai/gpt-oss-20b');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows deterministic offline browser tests to disable auto-connect', () => {
    expect(createLocalLLMProvider({ MODE: 'development', VITE_LM_STUDIO_AUTO_CONNECT: 'false' })).toBeNull();
  });

  it('surfaces provider HTTP failures', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'test-model',
      fetchImpl: vi.fn(async () => response({ error: { message: 'model unavailable' } }, false, 503)),
    });

    await expect(provider.generate([{ role: 'user', content: 'Hello' }])).rejects.toThrow('Provider request failed (503): model unavailable');
  });

  it('retries a transient LM Studio engine protocol failure once', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ error: { message: 'Engine protocol predict stream returned an error' } }, false, 400))
      .mockResolvedValueOnce(response({
        model: 'openai/gpt-oss-20b',
        choices: [{ message: { content: '{"placement":"new"}' } }],
      }));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'openai/gpt-oss-20b',
      fetchImpl,
    });

    await expect(provider.generate([{ role: 'user', content: 'Organize this lecture.' }])).resolves.toMatchObject({ content: '{"placement":"new"}' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not present a reasoning-only response as a final answer', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: '/lm-studio/v1', model: 'qwen/qwen3-4b',
      fetchImpl: vi.fn(async () => response({ choices: [{ message: { content: '', reasoning_content: 'Unfinished reasoning' }, finish_reason: 'length' }] })),
    });
    await expect(provider.generate([{ role: 'user', content: 'Explain' }])).rejects.toThrow('no final answer');
  });

  it('requests a direct Qwen3 answer and removes its empty thinking wrapper', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      choices: [{ message: { content: '<think>\n</think>\nPhotosynthesis converts light into chemical energy.' } }],
    }));
    const provider = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'qwen/qwen3-4b', fetchImpl });
    await expect(provider.generate([{ role: 'user', content: 'Explain' }])).resolves.toMatchObject({ content: 'Photosynthesis converts light into chemical energy.' });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(sent.messages[0].content).toContain('/no_think');
    expect(sent.reasoning_effort).toBe('none');
  });

  it('turns reasoning off for Qwen3 point releases such as qwen3.8', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ choices: [{ message: { content: 'Direct answer.' } }] }));
    const provider = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'qwen3.8-9b-distill', fetchImpl });
    await expect(provider.generate([{ role: 'user', content: 'Explain' }])).resolves.toMatchObject({ content: 'Direct answer.' });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(sent.reasoning_effort).toBe('none');
    expect(sent.messages[0].content).toContain('/no_think');
  });

  it('retries without the reasoning switch when a server rejects it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ error: { message: 'Unsupported value for reasoning_effort' } }, false, 400))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Answer.' } }] }));
    const provider = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'qwen/qwen3-4b', fetchImpl });
    await expect(provider.generate([{ role: 'user', content: 'Explain' }])).resolves.toMatchObject({ content: 'Answer.' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).reasoning_effort).toBeUndefined();
  });

  it('gives long generations more time than the base timeout on slow local hardware', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
      }));
      const provider = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'openai/gpt-oss-20b', fetchImpl, timeoutMs: 1_000 });
      const pending = provider.generate([{ role: 'user', content: 'Explain' }], { maxTokens: 4_096 });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(4_096 * 150);
      expect(aborted).toBe(true);
      await expect(pending).rejects.toThrow('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send the reasoning switch to other models', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ choices: [{ message: { content: 'Answer.' } }] }));
    const provider = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'openai/gpt-oss-20b', fetchImpl });
    await provider.generate([{ role: 'user', content: 'Explain' }]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string).reasoning_effort).toBeUndefined();
  });
});

describe('OpenAI-compatible LLM provider streaming', () => {
  const encoder = new TextEncoder();
  const delta = (content: string, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ choices: [{ delta: { content } }], ...extra })}\n\n`;
  const sse = (chunks: (string | Uint8Array)[], init: ResponseInit = {}) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, ...init });
  const providerFor = (fetchImpl: typeof fetch, model = 'fixture-model') => new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model, fetchImpl });
  const done = 'data: [DONE]\n\n';
  const finish = (reason: string | null) => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
  const ask = [{ role: 'user' as const, content: 'Explain' }];
  const sentBody = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String((fetchImpl.mock.calls[call][1] as RequestInit).body));

  it('asks for a stream only when a caller listens and no response format is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ choices: [{ message: { content: '{}' } }] }));
    const provider = providerFor(fetchImpl);
    const responseFormat = { type: 'json_schema' as const, json_schema: { name: 'x', schema: {} } };
    const onText = vi.fn();
    await provider.generate(ask);
    await provider.generate(ask, { responseFormat });
    await provider.generate(ask, { responseFormat, onText });
    expect(onText).not.toHaveBeenCalled();
    await provider.generate(ask, { onText });
    expect([0, 1, 2, 3].map((call) => sentBody(fetchImpl, call).stream)).toEqual([false, false, false, true]);
  });

  it('keeps a request without a listener byte for byte the same, with stream false in its place', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ choices: [{ message: { content: 'OK' } }] }));
    await providerFor(fetchImpl).generate(ask, { maxTokens: 512 });
    expect(fetchImpl.mock.calls[0][1]?.body).toBe('{"model":"fixture-model","messages":[{"role":"user","content":"Explain"}],"temperature":0,"max_tokens":512,"stream":false}');
  });

  it('reports the whole text so far and returns the complete answer with the streamed model', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello', { model: 'streamed-model' }), delta(' world'), 'data: [DONE]\n\n']));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).resolves.toEqual({ content: 'Hello world', model: 'streamed-model' });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(['Hello', 'Hello world']);
  });

  it('falls back to the configured model when the chunks name none', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello'), done]));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toEqual({ content: 'Hello', model: 'fixture-model' });
  });

  it.each(['stop', 'length', 'content_filter'])('accepts a finish_reason of %s as a clean end with no DONE, and returns the text', async (reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello'), finish(reason)]));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'Hello' });
  });

  it('accepts a finish_reason carried by the chunk with the last text', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] })}\n\n`]));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'Hello' });
  });

  it.each([
    ['no end signal', ['DELTA']],
    ['a null finish_reason', ['DELTA', 'NULL']],
    ['an empty finish_reason', ['DELTA', 'EMPTY']],
    ['a last event truncated by the end of the body', ['DELTA', 'data: {"choices":[{"delta":{},"finish_reason":"st']],
    ['an empty body', []],
  ])('treats a clean end with %s as a cut', async (_label, parts) => {
    const chunks = parts.map((part) => part === 'DELTA' ? delta('Partial') : part === 'NULL' ? finish(null) : part === 'EMPTY' ? finish('') : part);
    const fetchImpl = vi.fn<typeof fetch>(async () => sse(chunks));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).rejects.toThrow(/^Provider stream interrupted\.$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the answer when the connection is cut after a finish_reason', async () => {
    let sent = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) { controller.error(new TypeError('network error')); return; }
        sent = true;
        controller.enqueue(encoder.encode(`${delta('Hello')}${finish('stop')}`));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).resolves.toMatchObject({ content: 'Hello' });
    expect(onText).toHaveBeenLastCalledWith('Hello');
  });

  it('stops reading at a finish_reason and releases a connection the server keeps open', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`${delta('Hello')}${finish('length')}`)); },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'Hello' });
    expect(cancel).toHaveBeenCalled();
  });

  it('treats a finish_reason of error as a cut, not as a finished answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Partial'), finish('error'), done]));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).rejects.toThrow(/^Provider stream interrupted\.$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops reading at DONE and releases a connection the server keeps open', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`${delta('Hello')}data: [DONE]\n\n`)); },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'Hello' });
    expect(cancel).toHaveBeenCalled();
  });

  it('survives a character split across chunks, CRLF, comments and chunks without a delta', async () => {
    const bytes = encoder.encode(`: ping\r\n\r\n${delta('é€').replace(/\n/g, '\r\n')}data: {"choices":[]}\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\ndata: [DONE]\r\n\r\n`);
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([bytes.slice(0, 40), bytes.slice(40)]));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'é€' });
  });

  it('ignores reasoning_content and fires only when the visible text changes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([
      'data: {"choices":[{"delta":{"reasoning_content":"secret"}}]}\n\n',
      delta('A'),
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}\n\n',
      delta('B'),
      done,
    ]));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).resolves.toMatchObject({ content: 'AB' });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(['A', 'AB']);
  });

  it('hides reasoning tags while streaming, wherever the chunks split them', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('<th'), delta('ink>private'), delta(' thoughts</th'), delta('ink>\nHello'), delta(' <think>more'), delta('</think>there'), done]));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).resolves.toMatchObject({ content: 'Hello there' });
    const seen = onText.mock.calls.map(([text]) => text);
    expect(seen).toEqual(['Hello', 'Hello ', 'Hello there']);
    expect(seen.join()).not.toMatch(/private|thoughts|more|</);
  });

  it('applies the no final answer rule to the whole streamed text', async () => {
    for (const chunks of [[done], [delta('<think>only reasoning'), done], [delta('<think>a</think>  '), finish('stop')]]) {
      const onText = vi.fn();
      await expect(providerFor(vi.fn<typeof fetch>(async () => sse(chunks))).generate(ask, { onText })).rejects.toThrow('The model returned no final answer');
      expect(onText).not.toHaveBeenCalled();
    }
  });

  it('throws an error sent inside the stream and does not retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello'), 'data: {"error":{"message":"engine fell over"}}\n\n', delta(' world')]));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).rejects.toThrow('Provider request failed: engine fell over');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not take an empty error field for a failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse(['data: {"error":null,"choices":[{"delta":{"content":"Hello"}}]}\n\n', done]));
    await expect(providerFor(fetchImpl).generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'Hello' });
  });

  it.each(['network error', 'Error in input stream', 'NetworkError when attempting to fetch resource.'])('says the stream was interrupted when a read fails with %j, with no retry', async (browserText) => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode(delta('Hello')));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const onText = vi.fn(() => upstream.error(new TypeError(browserText)));
    await expect(providerFor(fetchImpl).generate(ask, { onText })).rejects.toThrow(/^Provider stream interrupted\.$/);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a stream beyond the JSON response limit', async () => {
    const pad = ':'.padEnd(1024 * 1024) + '\n\n';
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello'), ...Array.from({ length: 9 }, () => pad), delta('late')]));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).rejects.toThrow('The provider response is too large.');
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it('refuses a declared stream length beyond the limit without reading it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello')], { headers: { 'content-type': 'text/event-stream', 'content-length': String(8 * 1024 * 1024 + 1) } }));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).rejects.toThrow('The provider response is too large.');
    expect(onText).not.toHaveBeenCalled();
  });

  it('fires once with the final text when a server answers JSON to a streamed request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: 'json-model', choices: [{ message: { content: '<think>x</think> Whole answer. ' } }] }), { headers: { 'content-type': 'application/json' } }));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).resolves.toEqual({ content: 'Whole answer.', model: 'json-model' });
    expect(onText.mock.calls).toEqual([['Whole answer.']]);
  });

  it('retries a transient failure once before any text, then streams', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: { message: 'busy' } }, false, 503))
      .mockResolvedValueOnce(sse([delta('Hello'), done]));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).resolves.toMatchObject({ content: 'Hello' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchImpl, 1).stream).toBe(true);
    expect(onText.mock.calls).toEqual([['Hello']]);
  });

  it('keeps streaming after dropping a rejected reasoning switch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: { message: 'Unsupported value for reasoning_effort' } }, false, 400))
      .mockResolvedValueOnce(sse([delta('Hello'), done]));
    await expect(providerFor(fetchImpl, 'qwen/qwen3-4b').generate(ask, { onText: vi.fn() })).resolves.toMatchObject({ content: 'Hello' });
    expect(sentBody(fetchImpl, 0)).toMatchObject({ stream: true, reasoning_effort: 'none' });
    expect(sentBody(fetchImpl, 1).stream).toBe(true);
    expect(sentBody(fetchImpl, 1).reasoning_effort).toBeUndefined();
  });

  it('reads a non-ok event stream answer through the error path', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([delta('Hello')], { status: 401, headers: { 'content-type': 'text/event-stream' } }));
    const onText = vi.fn();
    await expect(providerFor(fetchImpl).generate(ask, { onText })).rejects.toThrow('Provider request failed (401)');
    expect(onText).not.toHaveBeenCalled();
  });

  it('applies the overall timer to a stream that stalls', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(delta('Hello')));
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
        },
      }), { headers: { 'content-type': 'text/event-stream' } }));
      const onText = vi.fn();
      const pending = new OpenAICompatibleProvider({ baseUrl: '/lm-studio/v1', model: 'm', fetchImpl, timeoutMs: 1_000 }).generate(ask, { maxTokens: 256, onText });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(256 * 150);
      await expect(pending).rejects.toThrow('Provider request timed out.');
      expect(onText.mock.calls).toEqual([['Hello']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a stream when the caller aborts', async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(delta('Hello')));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const pending = providerFor(fetchImpl).generate(ask, { signal: caller.signal, onText: () => caller.abort() });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
