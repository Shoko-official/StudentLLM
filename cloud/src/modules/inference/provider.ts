// The upstream proxy. An `UpstreamProvider` is the only thing in the gateway that talks to an inference provider.
// It is OpenAI-compatible and uses the injected `fetch`, so tests make no network call.
//
// Safety rules enforced HERE, at the boundary, and not by the callers:
// - The URL is `baseUrl` of a routing-table endpoint plus a FIXED path. The client supplies no URL, host, path,
//   header or provider name: the callers pass structured values (`ChatCall`, `TranscribeCall`) and this module
//   builds the request body from them field by field, so an unknown field cannot reach the upstream.
// - Only the headers listed here are sent; the client's headers never are.
// - Redirects are not followed (`redirect: "manual"`); a redirect response is a failure.
// - The provider's error text is never read, returned or logged: a non-2xx response is cancelled unread.
// - Nothing derived from content is logged.

import type { ProviderEndpoint } from "./routing";

/** Why an upstream call failed. `definitive` kinds are the strict `failed_no_usage` of the contract. */
export type UpstreamFailureKind =
  /** An explicit error response (a non-2xx status, or a 2xx body that is an error) with no completion. */
  | "error_response"
  /** A redirect response: not followed, an explicit response with no completion. */
  | "redirect"
  /** A connection failure before the request was accepted (DNS, refused, unreachable, TLS). */
  | "connect_failed"
  /** The gateway has no usable key or endpoint for the provider: nothing was sent. */
  | "unconfigured"
  /** The gateway's own timer fired. */
  | "timeout"
  /** The call was aborted (client abort, gateway abort). */
  | "aborted"
  /** A network error whose moment is unknown: a reset after bytes were sent, or a missing response. */
  | "network"
  /** A response that could not be understood. */
  | "malformed";

const DEFINITIVE: ReadonlySet<UpstreamFailureKind> = new Set(["error_response", "redirect", "connect_failed", "unconfigured"]);

export class UpstreamError extends Error {
  constructor(readonly kind: UpstreamFailureKind) {
    // The message never carries provider text.
    super(`upstream ${kind}`);
    this.name = "UpstreamError";
  }

  /**
   * True only for the strict `failed_no_usage` of docs/cloud-api.md: an explicit upstream error response with no
   * completion, or a connection failure before the request was accepted. Every timeout, abort, reset after bytes
   * were sent or missing response is an UNKNOWN outcome and settles at the full reservation.
   */
  get definitive(): boolean {
    return DEFINITIVE.has(this.kind);
  }
}

export interface UpstreamImagePart {
  type: "image_url";
  image_url: { url: string };
}
export interface UpstreamTextPart {
  type: "text";
  text: string;
}
export interface UpstreamMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<UpstreamTextPart | UpstreamImagePart>;
}

/** Everything a chat call may carry. The provider builds the request body from exactly these fields. */
export interface ChatCall {
  upstreamModel: string;
  messages: UpstreamMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  responseFormat?: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high";
  /** The per-account HMAC pseudonym. Never the email or the account id. */
  user: string;
  signal: AbortSignal;
}

export interface TranscribeCall {
  upstreamModel: string;
  file: { bytes: Uint8Array; mime: string; extension: string };
  language?: string;
  signal: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  language: string | null;
  /** The duration the provider reports, used for settlement; null when it reports none. */
  durationSeconds: number | null;
  segments: Array<{ start: number; end: number; text: string }>;
}

export interface OcrCall {
  upstreamModel: string;
  file: { bytes: Uint8Array; mime: string };
  language?: string;
  signal: AbortSignal;
}

/** Provisional: the OCR response schema of the contract is provisional until the provider is chosen. */
export interface OcrResult {
  text: string;
  blocks: Array<{ text: string; bbox: [number, number, number, number] | null }>;
}

export interface UpstreamProvider {
  readonly id: string;
  /** Resolves with a 2xx response whose body has not been read. Rejects with `UpstreamError`. */
  chat(call: ChatCall): Promise<Response>;
  transcribe?(call: TranscribeCall): Promise<TranscribeResult>;
  ocr?(call: OcrCall): Promise<OcrResult>;
}

/** Resolves the provider of a routing-table endpoint, or undefined when none is configured. */
export type ProviderRegistry = (providerId: string) => UpstreamProvider | undefined;

// Codes that mean the connection never got as far as being accepted. Anything else is an unknown outcome.
const PRE_ACCEPT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function errorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The Workers `fetch` rejects with a generic `TypeError` and does not say whether the request was accepted. Only an
 * error that names a connect-time cause counts as "before the request was accepted"; a timer, an abort or any other
 * error is an unknown outcome and is charged in full. This is deliberately conservative (docs/cloud-api.md).
 */
export function classifyFetchError(error: unknown, signal: AbortSignal | undefined): UpstreamError {
  if (signal?.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    return new UpstreamError(reason?.name === "TimeoutError" ? "timeout" : "aborted");
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError") return new UpstreamError("aborted");
  if (name === "TimeoutError") return new UpstreamError("timeout");
  const code = errorCode(error);
  if (code !== undefined && PRE_ACCEPT_CODES.has(code)) return new UpstreamError("connect_failed");
  return new UpstreamError("network");
}

/** Reads at most `maxBytes` of a response as text; more is a failure (the stream is cancelled). */
export async function readTextLimited(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const declared = response.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw new UpstreamError("malformed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new UpstreamError("malformed");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw classifyFetchError(error, signal);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export interface OpenAiProviderOptions {
  endpoint: ProviderEndpoint;
  /** The injected fetch (never the global one called directly). */
  fetch: typeof fetch;
  /** Returns the API key; called per request, so a rotated secret is picked up and a missing one is a clean failure. */
  apiKey: () => string;
  maxJsonBytes: number;
}

// The only upstream paths the gateway ever calls.
const CHAT_PATH = "/chat/completions";
const TRANSCRIPTION_PATH = "/audio/transcriptions";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An OpenAI-compatible provider (Groq is one): chat completions and audio transcriptions. */
export function createOpenAiCompatibleProvider(options: OpenAiProviderOptions): UpstreamProvider {
  const { endpoint } = options;

  async function send(path: string, init: { headers: Record<string, string>; body: BodyInit; signal: AbortSignal }): Promise<Response> {
    let key: string;
    try {
      key = options.apiKey();
    } catch {
      throw new UpstreamError("unconfigured");
    }
    const url = endpoint.baseUrl + path;
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers: { ...init.headers, Authorization: `Bearer ${key}` },
        body: init.body,
        redirect: "manual",
        signal: init.signal,
      });
    } catch (error) {
      throw classifyFetchError(error, init.signal);
    }
    // A redirect is never followed. `opaqueredirect` is what a manual-redirect fetch reports in browsers.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined);
      throw new UpstreamError("redirect");
    }
    if (!response.ok) {
      // The provider's error text is not read: it is mapped to a fixed code by the caller.
      void response.body?.cancel().catch(() => undefined);
      throw new UpstreamError("error_response");
    }
    return response;
  }

  return {
    id: endpoint.id,

    chat(call) {
      // The body is built field by field from the structured call: nothing else can reach the upstream.
      const body: Record<string, unknown> = {
        model: call.upstreamModel,
        messages: call.messages,
        stream: call.stream,
        max_tokens: call.maxTokens,
        user: call.user,
      };
      // The gateway forces usage in streamed responses: the settlement needs it.
      if (call.stream) body.stream_options = { include_usage: true };
      if (call.temperature !== undefined) body.temperature = call.temperature;
      if (call.topP !== undefined) body.top_p = call.topP;
      if (call.stop !== undefined) body.stop = call.stop;
      if (call.responseFormat !== undefined) body.response_format = call.responseFormat;
      if (call.reasoningEffort !== undefined) body.reasoning_effort = call.reasoningEffort;
      return send(CHAT_PATH, {
        headers: { "Content-Type": "application/json", Accept: call.stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(body),
        signal: call.signal,
      });
    },

    async transcribe(call) {
      const form = new FormData();
      // A fixed file name: the client's own name never reaches the provider.
      form.set("file", new Blob([call.file.bytes as Uint8Array<ArrayBuffer>], { type: call.file.mime }), `audio.${call.file.extension}`);
      form.set("model", call.upstreamModel);
      form.set("response_format", "verbose_json");
      if (call.language !== undefined) form.set("language", call.language);
      const response = await send(TRANSCRIPTION_PATH, { headers: { Accept: "application/json" }, body: form, signal: call.signal });
      const text = await readTextLimited(response, options.maxJsonBytes, call.signal);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new UpstreamError("malformed");
      }
      if (!isObject(json) || typeof json.text !== "string") {
        throw new UpstreamError(isObject(json) && "error" in json ? "error_response" : "malformed");
      }
      const segments: TranscribeResult["segments"] = [];
      if (Array.isArray(json.segments)) {
        for (const s of json.segments) {
          if (!isObject(s)) continue;
          const start = finite(s.start);
          const end = finite(s.end);
          if (start === null || end === null || typeof s.text !== "string") continue;
          segments.push({ start, end, text: s.text });
        }
      }
      return {
        text: json.text,
        language: typeof json.language === "string" ? json.language : null,
        durationSeconds: finite(json.duration),
        segments,
      };
    },
    // `ocr` is deliberately absent: no OCR provider is chosen yet (docs/cloud-plan.md, "Open items"). A deployment
    // that enables OCR injects a provider that implements it.
  };
}
