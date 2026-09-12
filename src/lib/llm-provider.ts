export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderResponse {
  content: string;
  model: string;
}

export interface LLMProvider {
  generate: (messages: ProviderMessage[]) => Promise<ProviderResponse>;
}

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function providerUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(messages: ProviderMessage[]): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(providerUrl(this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: /qwen3-/i.test(this.model)
            ? [{ role: 'system', content: 'Return the final answer directly. /no_think' }, ...messages]
            : messages,
          temperature: 0,
          max_tokens: 1024,
          stream: false,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof body?.error === 'string' ? body.error : body?.error?.message;
        throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : ''}`);
      }

      const message = body?.choices?.[0]?.message ?? {};
      const content = typeof message.content === 'string'
        ? message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        : '';
      if (!content || content.startsWith('<think>')) throw new Error('The model returned no final answer. Try again or choose another model in Settings.');
      return { content: content.trim(), model: typeof body.model === 'string' ? body.model : this.model };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Provider request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createLocalLLMProvider(env: Record<string, string | undefined> = import.meta.env) {
  if (env.VITE_LM_STUDIO_AUTO_CONNECT?.trim().toLowerCase() === 'false') return null;
  const baseUrl = env.VITE_LM_STUDIO_BASE_URL?.trim() || (env.MODE === 'development' ? '/lm-studio/v1' : undefined);
  if (!baseUrl) return null;
  return new OpenAICompatibleProvider({
    baseUrl,
    model: env.VITE_LM_STUDIO_MODEL?.trim() || 'openai/gpt-oss-20b',
  });
}
