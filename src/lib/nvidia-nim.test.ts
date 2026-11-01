import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NIM_MODEL, NIM_MODELS, nimChatTemplateKwargs, probeNimModel } from './nvidia-nim';

const answer = (content: unknown = 'OK', extra: object = {}) => new Response(JSON.stringify({
  choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
}), { headers: { 'content-type': 'application/json' } });

afterEach(() => vi.useRealTimers());

describe('probeNimModel', () => {
  it('lets the verified Mistral profile reach a final answer within its bounded probe budget', async () => {
    const model = 'mistralai/mistral-large-4-1t-a52b';
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => answer(JSON.parse(init?.body as string).max_tokens === 128 ? 'OK' : null));
    expect(await probeNimModel(model, { fetchImpl })).toEqual({ ok: true, model });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(NIM_MODELS.some(entry => entry.id === model)).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).not.toHaveProperty('chat_template_kwargs');
  });
  it('checks real chat completion through the local proxy with a small synthetic prompt and no credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answer());
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl })).toEqual({ ok: true, model: DEFAULT_NIM_MODEL });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/nvidia-nim/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      messages: [{ role: 'user', content: 'Reply exactly OK.' }],
      max_tokens: 8,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(NIM_MODELS.some(({ id }) => id === DEFAULT_NIM_MODEL)).toBe(true);
  });

  it('sends an unlisted model as selected without inventing model-specific parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answer());
    expect(await probeNimModel('custom/model', { fetchImpl })).toEqual({ ok: true, model: 'custom/model' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      model: 'custom/model', messages: [{ role: 'user', content: 'Reply exactly OK.' }], max_tokens: 8, stream: false,
    });
    expect(nimChatTemplateKwargs('custom/model')).toBeUndefined();
  });

  it.each([
    [503, 'missing_key', 'missing_key', false, 'Unavailable. NVIDIA_API_KEY is not set'],
    [403, 'forbidden', 'forbidden', false, 'Unavailable. NVIDIA NIM requires a local same-origin browser request.'],
    [401, undefined, 'authentication', false, 'Unavailable. NVIDIA NIM rejected the server credential.'],
    [403, undefined, 'authentication', false, 'Unavailable. NVIDIA NIM rejected the server credential.'],
    [429, undefined, 'quota', false, 'Unavailable. NVIDIA NIM rate limit or quota reached. Try again later.'],
    [404, undefined, 'retired', true, 'Unavailable. This NVIDIA NIM model is no longer available.'],
    [410, undefined, 'retired', true, 'Unavailable. This NVIDIA NIM model is no longer available.'],
    [404, 'not_found', 'http', false, 'Unavailable. NVIDIA NIM answered with HTTP 404.'],
    [504, undefined, 'timeout', true, 'Unavailable. NVIDIA NIM did not return a final answer in time.'],
    [502, 'timeout', 'timeout', true, 'Unavailable. NVIDIA NIM did not return a final answer in time.'],
    [503, undefined, 'http', false, 'Unavailable. NVIDIA NIM answered with HTTP 503.'],
  ])('classifies HTTP %s (%s) without displaying arbitrary upstream text', async (status, proxyError, kind, canFallback, message) => {
    const headers = proxyError ? { 'x-studentllm-proxy-error': proxyError } : undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private upstream body', { status, headers }));
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl })).toEqual({ ok: false, kind, canFallback, message });
  });

  it.each([
    [null, { reasoning_content: 'OK' }],
    ['', { reasoning_content: 'OK' }],
    ['  ', {}],
    ['<think>Need to say OK.</think>', {}],
    ['<think>Still reasoning', {}],
    [{ text: 'OK' }, {}],
  ])('does not mistake empty or reasoning-only content for a final answer (%s)', async (content, extra) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answer(content, extra));
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl })).toMatchObject({ ok: false, kind: 'no-final-answer', canFallback: false });
  });

  it('accepts a final answer after a think block', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answer('<think>Reasoning</think> OK'));
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl })).toEqual({ ok: true, model: DEFAULT_NIM_MODEL });
  });

  it.each(['not JSON', '{}', '{"choices":[]}'])('handles malformed completion responses (%s)', async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl })).toMatchObject({ ok: false, kind: 'no-final-answer', canFallback: false });
  });

  it('reports network failure without propagating exception text', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('private details'));
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl })).toEqual({
      ok: false, kind: 'network', canFallback: false, message: 'Unavailable. Could not reach NVIDIA NIM through the local proxy.',
    });
  });

  it('bounds the entire request at 15 seconds even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ ok: false, kind: 'timeout', canFallback: true });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while the completion body is being read', async () => {
    vi.useFakeTimers();
    const response = answer();
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, kind: 'timeout', canFallback: true });
  });

  it('cancels an active probe without permitting a fallback', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, kind: 'cancelled', canFallback: false });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not start a request when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await probeNimModel(DEFAULT_NIM_MODEL, { fetchImpl, signal: controller.signal })).toMatchObject({ ok: false, kind: 'cancelled', canFallback: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
