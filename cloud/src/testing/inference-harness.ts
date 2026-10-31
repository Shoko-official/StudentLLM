// Test-only: the app wired the way the inference module's tests need it. It seeds one Plus account with a window of
// budget and an active consent record, fakes the other modules' hooks (authenticate, terms, plan, connection rate
// limit) and gives the tests a fake upstream so that no network call is possible.
//
//   const h = makeInferenceHarness({ upstream: (call) => completion("Hello", { prompt: 10, completion: 5 }) });
//   const res = await h.chat({ model: "studentllm-large", messages: [{ role: "user", content: "hi" }] });

import { loadConfig } from "../config";
import { defaultRequestId } from "../deps";
import type { Step } from "../http/context";
import { createBillingDeps } from "../modules/billing";
import { createInferenceDeps, type InferenceOptions } from "../modules/inference";
import type { ProviderRegistry } from "../modules/inference/provider";
import { DEFAULT_ROUTING, type RoutingConfig } from "../modules/inference/routing";
import { createInMemoryStores, type Stores } from "../storage";
import type { PlanRecord } from "../storage";
import { accessPrincipal, fakeAuthenticate, fakeExecutionContext, makeTestApp, ManualClock, testEnv, TEST_START_MS, type TestApp } from "./test-app";

export const ACCOUNT_ID = "acc_test";
export const CONSENT_ID = "cns_test";
export const PERIOD = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1) };

/** A marker that appears in every prompt the tests send: it must never show up in a log, a store or an error. */
export const SECRET_PROMPT = "ZEBRA-QUARTZ-PROMPT-MARKER-7731";

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------------------------------
// Fake upstream
// ---------------------------------------------------------------------------------------------------

export interface UpstreamCall {
  url: string;
  method: string;
  /** Header names are lower case. */
  headers: Record<string, string>;
  /** The parsed JSON body; for a multipart body, the list of its field names. */
  body: any;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}

export type UpstreamHandler = (call: UpstreamCall, index: number) => Response | Promise<Response>;

export function fakeUpstream(handler: UpstreamHandler): { fetch: typeof fetch; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof FormData) body = { fields: [...init.body.keys()], form: init.body };
    const call: UpstreamCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
      redirect: init?.redirect,
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

export interface Usage {
  prompt: number;
  completion: number;
  reasoning?: number;
}

export function usageObject(u: Usage): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    prompt_tokens: u.prompt,
    completion_tokens: u.completion,
    total_tokens: u.prompt + u.completion,
  };
  if (u.reasoning !== undefined) usage.completion_tokens_details = { reasoning_tokens: u.reasoning };
  return usage;
}

/** A non-streaming OpenAI-style answer. */
export function completion(content: string, usage?: Usage | null, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = {
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1790000000,
    model: "openai/gpt-oss-120b",
    system_fingerprint: "fp_secret_detail",
    x_groq: { id: "req_provider_detail" },
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...extra,
  };
  if (usage) body.usage = usageObject(usage);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

export function chunkFrame(content: string, finish: string | null = null): string {
  const delta = content === "" ? {} : { content };
  return `data: ${JSON.stringify({
    id: "chatcmpl-upstream",
    object: "chat.completion.chunk",
    created: 1790000000,
    model: "openai/gpt-oss-120b",
    x_groq: { id: "req_provider_detail" },
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export function usageFrame(u: Usage): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-upstream", object: "chat.completion.chunk", created: 1790000000, model: "openai/gpt-oss-120b", choices: [], usage: usageObject(u) })}\n\n`;
}

export const DONE_FRAME = "data: [DONE]\n\n";

export interface SseOptions {
  /** How the stream ends after the frames: close cleanly, reset (an error), or hang until the call is aborted. */
  end?: "close" | "reset" | "hang";
  signal?: AbortSignal | null;
  /** Called after each frame was handed out (lets a test act between frames). */
  onFrame?: (index: number) => void;
}

export function sseResponse(frames: string[], options: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]!));
        options.onFrame?.(i);
        i++;
        return;
      }
      switch (options.end ?? "close") {
        case "close":
          controller.close();
          return;
        case "reset":
          controller.error(new TypeError("Network connection lost."));
          return;
        case "hang":
          return new Promise<void>((_, reject) => {
            const abort = () => {
              controller.error(options.signal?.reason ?? new Error("aborted"));
              reject(options.signal?.reason);
            };
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
          }).catch(() => undefined);
      }
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A stream the test drives by hand: nothing is delivered until `push`, so a test can act between frames. */
export function manualSse(): { response: Response; push(frame: string): void; close(): void; reset(): void } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    push: (frame) => controller.enqueue(encoder.encode(frame)),
    close: () => controller.close(),
    reset: () => controller.error(new TypeError("Network connection lost.")),
  };
}

export function errorResponse(status: number, text = "provider detail that must never leak"): Response {
  return new Response(JSON.stringify({ error: { message: text, type: "server_error" } }), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------------

export interface HarnessOptions {
  upstream?: UpstreamHandler;
  /** Use this fetch instead of the fake upstream (for a test that provides its own). */
  fetch?: typeof fetch;
  routing?: RoutingConfig;
  settings?: InferenceOptions["settings"];
  providers?: ProviderRegistry;
  stores?: Stores;
  clock?: ManualClock;
  /** false: no plan on the account (a free account). Default true. */
  plus?: boolean;
  /** The plan to seed instead of the default monthly Plus plan (for example one read from a webhook-created plan). */
  plan?: PlanRecord;
  /** Credits of one budget window, set in the BILLING settings (where the module reads them from). Default: billing's own. */
  windowCredits?: number;
  /** false: no consent record. Default true. */
  consent?: boolean;
  /** Replace fake hooks of the other modules, for example `{ checkPlan: ... }`. */
  hooks?: Partial<Record<"checkTermsAndStatus" | "checkPlan" | "checkAuthRateLimit", Step>>;
}

export interface Harness {
  t: TestApp;
  stores: Stores;
  clock: ManualClock;
  upstreamCalls: UpstreamCall[];
  executionCtx: ReturnType<typeof fakeExecutionContext>;
  /** POST /v1/chat/completions with the standard headers; `headers` override them (use `null` to remove one). */
  chat(body: unknown, headers?: Record<string, string | null>): Promise<Response>;
  /** The same through `app.handle` with the recording execution context. */
  chatWith(body: unknown, headers?: Record<string, string | null>, init?: RequestInit): Promise<Response>;
  /** GET with the standard authenticated headers. */
  get(path: string, headers?: Record<string, string | null>): Promise<Response>;
  /** POST a multipart form to a content route. */
  postForm(path: string, form: FormData, headers?: Record<string, string | null>): Promise<Response>;
  headers(extra?: Record<string, string | null>): Record<string, string>;
  /** A fresh idempotency key. */
  key(): string;
}

export function planRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    accountId: ACCOUNT_ID,
    planId: "plus_monthly",
    status: "active",
    paidPeriods: [PERIOD],
    cancelAtPeriodEnd: false,
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    lastEventAt: null,
    ...overrides,
  };
}

const passThrough: Step = () => undefined;

export function makeInferenceHarness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? new ManualClock();
  const stores = options.stores ?? createInMemoryStores();
  const upstream = fakeUpstream(options.upstream ?? (() => completion("OK", { prompt: 10, completion: 5 })));
  const fetchImpl = options.fetch ?? upstream.fetch;
  const config = loadConfig(testEnv());
  const core = { config, clock, stores, ids: { requestId: defaultRequestId }, fetch: fetchImpl, log: { request: () => undefined } };
  const inference = createInferenceDeps(core, { routing: options.routing ?? DEFAULT_ROUTING, settings: options.settings, providers: options.providers });
  // The budget of a window is the billing module's setting: the harness changes it there, like a deployment would.
  const billing = createBillingDeps(
    core,
    options.windowCredits === undefined ? {} : { settings: { windowCredits: { plus_monthly: options.windowCredits, plus_semester: options.windowCredits } } },
  );
  const t = makeTestApp({
    config,
    stores,
    clock,
    fetch: fetchImpl,
    deps: { inference, billing },
    hooks: {
      authenticate: fakeAuthenticate(accessPrincipal({ accountId: ACCOUNT_ID })),
      checkTermsAndStatus: options.hooks?.checkTermsAndStatus ?? passThrough,
      checkPlan: options.hooks?.checkPlan ?? passThrough,
      checkAuthRateLimit: options.hooks?.checkAuthRateLimit ?? passThrough,
    },
  });
  const executionCtx = fakeExecutionContext();

  // Seed (synchronously enough: the in-memory stores resolve immediately, and every request awaits `ready`).
  const ready = (async () => {
    await stores.accounts.create({ accountId: ACCOUNT_ID, email: "student@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "2026-11-01", now: TEST_START_MS });
    if (options.plus !== false) await stores.accounts.savePlan(options.plan ?? planRecord(), { expectedPlanVersion: 0 });
    if (options.consent !== false) {
      await stores.consents.record(
        { consentId: CONSENT_ID, accountId: ACCOUNT_ID, providerSetId: "ps1", providerSetVersion: 1, features: ["chat", "transcription", "ocr"], textVersion: "2026-11-01", granted: true },
        TEST_START_MS,
      );
    }
  })();

  let keyCounter = 0;
  const key = () => uuid(++keyCounter);
  const headers = (extra: Record<string, string | null> = {}): Record<string, string> => {
    const base: Record<string, string> = {
      Authorization: "Bearer eyJhbGciOiJFZERTQSJ9.EXAMPLE.EXAMPLE",
      "X-StudentLLM-Client": "studentllm-desktop/0.2.0",
      "X-StudentLLM-Consent": CONSENT_ID,
      "Idempotency-Key": key(),
    };
    for (const [name, value] of Object.entries(extra)) {
      if (value === null) delete base[name];
      else base[name] = value;
    }
    return base;
  };

  const send = async (path: string, init: RequestInit, raw = false): Promise<Response> => {
    await ready;
    const res = await t.app.handle(new Request(new URL(path, "https://api.example.invalid"), init), executionCtx);
    if (raw) return res;
    // A response body that is never read keeps its concurrency slot (it is released when the body ends), exactly as
    // for a real client that does not read the answer. Buffer it so a test that ignores the body does not leak slots.
    const bytes = await res.arrayBuffer();
    return new Response(bytes, { status: res.status, headers: res.headers });
  };
  const isStream = (body: unknown): boolean => typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;

  return {
    t,
    stores,
    clock,
    upstreamCalls: upstream.calls,
    executionCtx,
    // A streaming request returns the live response (the test reads it); every other one is buffered.
    chat: (body, extra) =>
      send("/v1/chat/completions", { method: "POST", headers: { ...headers(extra), "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }, isStream(body)),
    chatWith: (body, extra, init) =>
      send("/v1/chat/completions", { method: "POST", headers: { ...headers(extra), "Content-Type": "application/json" }, body: JSON.stringify(body), ...init }, true),
    get: (path, extra) => send(path, { method: "GET", headers: headers({ "Idempotency-Key": null, "X-StudentLLM-Consent": null, ...extra }) }),
    postForm: (path, form, extra) => send(path, { method: "POST", headers: headers(extra), body: form }),
    headers,
    key,
  };
}

/** A routing table with the default chat model plus a transcription and an OCR model, for the media routes. */
export function routingWithMedia(overrides: { chat?: Partial<Extract<RoutingConfig["models"][number], { feature: "chat" }>>; maxDurationMs?: number } = {}): RoutingConfig {
  const chat = DEFAULT_ROUTING.models[0] as Extract<RoutingConfig["models"][number], { feature: "chat" }>;
  const duration = overrides.maxDurationMs ?? 120_000;
  return {
    providers: DEFAULT_ROUTING.providers,
    providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, features: ["chat", "transcription", "ocr"] }],
    models: [
      { ...chat, maxDurationMs: duration, ...overrides.chat },
      {
        id: "studentllm-transcribe",
        feature: "transcription",
        providerSetId: "ps1",
        targets: [{ providerId: "groq", upstreamModel: "whisper-large-v3-turbo" }],
        maxDurationMs: duration,
        maxAudioBytes: 2 * 1024 * 1024,
        maxAudioSeconds: 600,
        price: { perMinute: 6 },
        enabled: true,
      },
      {
        id: "studentllm-ocr",
        feature: "ocr",
        providerSetId: "ps1",
        targets: [{ providerId: "groq", upstreamModel: "example-ocr" }],
        maxDurationMs: duration,
        maxImageBytes: 1024 * 1024,
        price: { perMiB: 40 },
        enabled: true,
      },
    ],
  };
}

export interface WavOptions {
  sampleRate?: number;
  channels?: number;
  bits?: number;
  /** The format tag (1 is PCM). */
  format?: number;
  /** Header fields to forge: by default they are consistent (`blockAlign = channels x bits / 8`, `byteRate = sampleRate x blockAlign`). */
  blockAlign?: number;
  byteRate?: number;
  /** The number of data bytes (by default `seconds` of audio at the stated format). */
  dataBytes?: number;
  /** The size the data chunk STATES, when it should differ from the bytes that follow. */
  statedDataBytes?: number;
}

/** A minimal WAV of `seconds` of silence, 8 kHz mono 8-bit PCM (8000 bytes per second) unless `options` say otherwise. */
export function wavBytes(seconds: number, options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 8000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 8;
  const blockAlign = options.blockAlign ?? channels * (bits / 8);
  const byteRate = options.byteRate ?? sampleRate * channels * (bits / 8);
  const dataSize = options.dataBytes ?? Math.round(seconds * sampleRate * channels * (bits / 8));
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, options.format ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  text(36, "data");
  view.setUint32(40, options.statedDataBytes ?? dataSize, true);
  return bytes;
}

/** A tiny PNG signature followed by padding: enough for the content sniffing, not a decodable image. */
export function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

export function pngDataUrl(size = 64): string {
  let binary = "";
  for (const b of pngBytes(size)) binary += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(binary)}`;
}

/** Everything a store holds, as text, so a test can prove no prompt reached it. Walks Maps, Sets and arrays. */
export function dumpStores(stores: Stores): string {
  const seen = new WeakSet<object>();
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") return void out.push(value);
    if (typeof value === "number" || typeof value === "boolean") return void out.push(String(value));
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        walk(k);
        walk(v);
      }
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const v of value) walk(v);
    } else {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        walk(v);
      }
    }
  };
  walk(stores);
  return out.join("\n");
}
