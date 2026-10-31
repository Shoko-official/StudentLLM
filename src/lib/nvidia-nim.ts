import config from './nvidia-nim-models.json';

export const DEFAULT_NIM_MODEL = config.defaultModel;
export const NIM_MODELS = config.models;
export const NIM_PROXY_BASE_URL = '/nvidia-nim/v1';

export type NimProbeResult =
  | { ok: true; model: string }
  | { ok: false; kind: string; message: string; canFallback: boolean };

export function nimChatTemplateKwargs(model: string): { enable_thinking: boolean } | undefined {
  return NIM_MODELS.find(({ id }) => id === model)?.chatTemplateKwargs;
}

function unavailable(kind: string, message: string, canFallback = false): NimProbeResult {
  return { ok: false, kind, message, canFallback };
}

const cancelled = () => unavailable('cancelled', 'NVIDIA NIM check cancelled.');
const timedOut = () => unavailable('timeout', 'Unavailable. NVIDIA NIM did not return a final answer in time.', true);
const noFinalAnswer = () => unavailable('no-final-answer', 'Unavailable. NVIDIA NIM did not return a final answer.');

function responseFailure(response: Response): NimProbeResult {
  const proxyError = response.headers.get('x-studentllm-proxy-error');
  if (proxyError === 'missing_key') return unavailable('missing_key', 'Unavailable. NVIDIA_API_KEY is not set');
  if (proxyError === 'forbidden') return unavailable('forbidden', 'Unavailable. NVIDIA NIM requires a local same-origin browser request.');
  if (response.status === 401 || response.status === 403) return unavailable('authentication', 'Unavailable. NVIDIA NIM rejected the server credential.');
  if (response.status === 429) return unavailable('quota', 'Unavailable. NVIDIA NIM rate limit or quota reached. Try again later.');
  if (!proxyError && (response.status === 404 || response.status === 410)) return unavailable('retired', 'Unavailable. This NVIDIA NIM model is no longer available.', true);
  if (response.status === 504 || proxyError === 'timeout') return timedOut();
  return unavailable('http', `Unavailable. NVIDIA NIM answered with HTTP ${response.status}.`);
}

/** A small real completion, with a deadline covering both the request and its body. */
export async function probeNimModel(model: string, options: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<NimProbeResult> {
  if (options.signal?.aborted) return cancelled();
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(options.timeoutMs!, 15_000))
    : 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel = () => {};
  const interrupted = new Promise<NimProbeResult>((resolve) => {
    const stop = (result: NimProbeResult) => {
      resolve(result);
      controller.abort();
    };
    onCancel = () => stop(cancelled());
    options.signal?.addEventListener('abort', onCancel, { once: true });
    timer = setTimeout(() => stop(timedOut()), timeoutMs);
  });

  const checkCompletion = async (): Promise<NimProbeResult> => {
    let response: Response;
    try {
      const chatTemplateKwargs = nimChatTemplateKwargs(model);
      response = await fetchImpl(`${NIM_PROXY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply exactly OK.' }],
          max_tokens: 8,
          stream: false,
          ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
        }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      return unavailable('network', 'Unavailable. Could not reach NVIDIA NIM through the local proxy.');
    }
    if (!response.ok) return responseFailure(response);
    try {
      const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] } | null;
      const content = payload?.choices?.[0]?.message?.content;
      // Some models put reasoning in content instead of reasoning_content. Neither is a final answer.
      const finalContent = typeof content === 'string'
        ? content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '').trim()
        : '';
      return finalContent ? { ok: true, model } : noFinalAnswer();
    } catch {
      return noFinalAnswer();
    }
  };

  try {
    // The race also bounds fetch/body implementations that do not honor AbortSignal.
    return await Promise.race([checkCompletion(), interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCancel);
  }
}
