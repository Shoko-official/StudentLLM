export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderResponse {
  content: string;
  model: string;
}

export interface ProviderResponseFormat {
  type: 'json_schema' | 'text';
  json_schema?: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

export interface ProviderGenerateOptions {
  responseFormat?: ProviderResponseFormat;
  maxTokens?: number;
}

export interface LLMProvider {
  generate: (messages: ProviderMessage[], options?: ProviderGenerateOptions) => Promise<ProviderResponse>;
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

function isRetryableProviderFailure(status: number, detail: string) {
  return status === 408 || status === 429 || status >= 500 || /engine protocol predict stream returned an error/i.test(detail);
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

  async generate(messages: ProviderMessage[], options?: ProviderGenerateOptions): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestBody = JSON.stringify({
      model: this.model,
      messages: /qwen3-/i.test(this.model)
        ? [{ role: 'system', content: 'Return the final answer directly. /no_think' }, ...messages]
        : messages,
      temperature: 0,
      max_tokens: Math.max(256, Math.min(options?.maxTokens ?? 1024, 16_384)),
      stream: false,
      ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
    });
    let attempt = 0;
    try {
      while (true) {
        const response = await this.fetchImpl(providerUrl(this.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        });
        const responseBody = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = typeof responseBody?.error === 'string' ? responseBody.error : responseBody?.error?.message;
          if (attempt === 0 && isRetryableProviderFailure(response.status, detail ?? '')) {
            attempt += 1;
            continue;
          }
          throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : ''}`);
        }

        const message = responseBody?.choices?.[0]?.message ?? {};
        const content = typeof message.content === 'string'
          ? message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
          : '';
        if (!content || content.startsWith('<think>')) throw new Error('The model returned no final answer. Try again or choose another model in Settings.');
        return { content: content.trim(), model: typeof responseBody.model === 'string' ? responseBody.model : this.model };
      }
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
