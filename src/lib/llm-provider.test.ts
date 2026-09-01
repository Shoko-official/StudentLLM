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

  it('surfaces provider HTTP failures', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'test-model',
      fetchImpl: vi.fn(async () => response({ error: { message: 'model unavailable' } }, false, 503)),
    });

    await expect(provider.generate([{ role: 'user', content: 'Hello' }])).rejects.toThrow('Provider request failed (503): model unavailable');
  });
});
