import { DIRECT_ANSWER_PROMPT } from '../prompts';

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
  signal?: AbortSignal;
  responseFormat?: ProviderResponseFormat;
  maxTokens?: number;
  /** Receives the whole visible text so far. Asks the server for a stream, so it is ignored with a responseFormat. */
  onText?: (text: string) => void;
}

export interface LLMProvider {
  generate: (messages: ProviderMessage[], options?: ProviderGenerateOptions) => Promise<ProviderResponse>;
  embed?: (inputs: string[]) => Promise<number[][]>;
  supportsStructuredOutputs?: boolean;
  contextWindowTokens?: number;
  /** Enforce the separate image-consent boundary on transient text copies before splitting. */
  redactEmbeddedImages?: boolean;
}

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  chatTemplateKwargs?: { enable_thinking: boolean };
}

function providerUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

function embeddingsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/embeddings`;
}

const SLOW_GENERATION_MS_PER_TOKEN = 150;

function isRetryableProviderFailure(status: number, detail: string) {
  return status === 408 || status === 429 || status >= 500 || /engine protocol predict stream returned an error/i.test(detail);
}

function errorDetail(errorValue: unknown) {
  return typeof errorValue === 'string'
    ? errorValue
    : errorValue && typeof errorValue === 'object' && typeof (errorValue as { message?: unknown }).message === 'string'
      ? (errorValue as { message: string }).message
      : undefined;
}

function finalAnswer(text: string) {
  const content = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!content || content.startsWith('<think>')) throw new Error('The model returned no final answer. Try again or choose another model in Settings.');
  return content;
}

function visibleText(text: string) {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = closed.indexOf('<think>');
  // The end of the text may be the beginning of a tag that the next chunk completes.
  return (open === -1 ? closed : closed.slice(0, open)).replace(/<(?:t(?:h(?:i(?:nk?)?)?)?)?$/, '').trimStart();
}

function isEventStream(response: Response) {
  return /^text\/event-stream\b/i.test(response.headers?.get?.('content-type') ?? '');
}

async function readEventStream(response: Response, onText: ProviderGenerateOptions['onText']) {
  const tooLarge = () => new Error('The provider response is too large.');
  if (Number(response.headers.get('content-length')) > MAX_JSON_RESPONSE_BYTES) throw tooLarge();
  const parser = createEventStreamParser();
  let text = '';
  let visible = '';
  let model: string | undefined;
  let size = 0;
  let finished = false;
  const reader = response.body?.getReader();
  try {
    while (reader && !finished) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        // Each browser words a failed body read its own way, and none of them tells a student anything.
        throw new Error('Provider stream interrupted.');
      }
      if (!next.done) {
        size += next.value.byteLength;
        if (size > MAX_JSON_RESPONSE_BYTES) throw tooLarge();
      }
      finished = next.done;
      for (const payload of next.done ? parser.end() : parser.push(next.value)) {
        if (payload.trim() === '[DONE]') { finished = true; break; }
        let chunk: { model?: unknown; error?: unknown; choices?: { delta?: { content?: unknown } }[] } | null;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk?.error) {
          const detail = errorDetail(chunk.error);
          throw new Error(`Provider request failed${detail ? `: ${detail}` : ''}`);
        }
        if (typeof chunk?.model === 'string') model = chunk.model;
        const content = Array.isArray(chunk?.choices) ? chunk.choices[0]?.delta?.content : undefined;
        if (typeof content === 'string') text += content;
      }
      const nextVisible = visibleText(text);
      if (nextVisible !== visible) {
        visible = nextVisible;
        onText?.(visible);
      }
    }
  } finally {
    void reader?.cancel().catch(() => undefined);
  }
  return { text, model };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly supportsStructuredOutputs = true;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly chatTemplateKwargs: OpenAICompatibleProviderOptions['chatTemplateKwargs'];

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.chatTemplateKwargs = options.chatTemplateKwargs;
  }

  async generate(messages: ProviderMessage[], options?: ProviderGenerateOptions): Promise<ProviderResponse> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    if (options?.signal?.aborted) controller.abort();
    const maxTokens = Math.max(256, Math.min(options?.maxTokens ?? 1024, 16_384));
    // A local model on a laptop CPU can generate only a few tokens per second, so long answers
    // get proportionally more time instead of being abandoned while the server keeps generating.
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, maxTokens * SLOW_GENERATION_MS_PER_TOKEN));
    // Qwen3-family models (qwen3-4b, qwen3.8-9b, ...) reason by default and can spend the whole
    // token budget before answering; ask for a direct answer and drop the switch if a server rejects it.
    const directAnswer = /qwen3/i.test(this.model);
    const onText = options?.responseFormat ? undefined : options?.onText;
    const buildBody = (withReasoningSwitch: boolean) => JSON.stringify({
      model: this.model,
      messages: directAnswer
        ? [{ role: 'system', content: DIRECT_ANSWER_PROMPT }, ...messages]
        : messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: Boolean(onText),
      ...(this.chatTemplateKwargs ? { chat_template_kwargs: this.chatTemplateKwargs } : {}),
      ...(withReasoningSwitch ? { reasoning_effort: 'none' } : {}),
      ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
    });
    let requestBody = buildBody(directAnswer);
    if (requestBody.length > MAX_JSON_REQUEST_BYTES) throw new Error('The provider request is too large.');
    let attempt = 0;
    let reasoningSwitchSent = directAnswer;
    try {
      while (true) {
        const response = await this.fetchImpl(providerUrl(this.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        });
        if (response.ok && isEventStream(response)) {
          const { text, model } = await readEventStream(response, onText);
          return { content: finalAnswer(text), model: model ?? this.model };
        }
        const responseBody = await readJsonResponse(response, 'provider');
        if (!response.ok) {
          const detail = errorDetail(responseBody.error);
          if (reasoningSwitchSent && response.status === 400 && /reasoning/i.test(detail ?? '')) {
            reasoningSwitchSent = false;
            requestBody = buildBody(false);
            continue;
          }
          if (attempt === 0 && isRetryableProviderFailure(response.status, detail ?? '')) {
            attempt += 1;
            continue;
          }
          throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : ''}`);
        }

        const choices = Array.isArray(responseBody.choices) ? responseBody.choices : [];
        const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : undefined;
        const messageRecord = message && typeof message === 'object' ? message as { content?: unknown } : {};
        const content = finalAnswer(typeof messageRecord.content === 'string' ? messageRecord.content : '');
        onText?.(content);
        return { content, model: typeof responseBody.model === 'string' ? responseBody.model : this.model };
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && !options?.signal?.aborted) throw new Error('Provider request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', cancel);
    }
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (!inputs.length) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(embeddingsUrl(this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: inputs }),
        signal: controller.signal,
      });
      const responseBody = await readJsonResponse(response, 'embedding provider');
      if (!response.ok) throw new Error('Embedding endpoint unavailable.');
      const data = Array.isArray(responseBody?.data) ? responseBody.data : [];
      const vectors = data.map((item: unknown) => {
        if (!item || typeof item !== 'object' || !Array.isArray((item as { embedding?: unknown }).embedding)) return null;
        const embedding = (item as { embedding: unknown[] }).embedding;
        return embedding.every((value) => typeof value === 'number' && Number.isFinite(value)) ? embedding as number[] : null;
      });
      if (vectors.length !== inputs.length || vectors.some((vector: number[] | null) => !vector?.length)) throw new Error('Embedding endpoint returned an invalid response.');
      return vectors as number[][];
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Embedding request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createLocalLLMProvider(env: Record<string, string | undefined> = import.meta.env, options: Pick<OpenAICompatibleProviderOptions, 'chatTemplateKwargs'> = {}) {
  if (env.VITE_LM_STUDIO_AUTO_CONNECT?.trim().toLowerCase() === 'false') return null;
  const baseUrl = env.VITE_LM_STUDIO_BASE_URL?.trim() || (env.MODE === 'development' ? '/lm-studio/v1' : undefined);
  if (!baseUrl) return null;
  try {
    return new OpenAICompatibleProvider({
      baseUrl,
      model: env.VITE_LM_STUDIO_MODEL?.trim() || 'openai/gpt-oss-20b',
      chatTemplateKwargs: options.chatTemplateKwargs,
    });
  } catch {
    return null;
  }
}
import { createEventStreamParser } from './event-stream';
import { MAX_JSON_REQUEST_BYTES, MAX_JSON_RESPONSE_BYTES, readJsonResponse } from './response-json';
import { normalizeServiceBaseUrl } from './service-url';
