import { describe, expect, it, vi } from 'vitest';
import { createLocalLLMProvider, OpenAICompatibleProvider } from './llm-provider';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('OpenAI-compatible LLM provider', () => {
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
  });
});
