import { describe, expect, it } from "vitest";
import { ConfigError } from "../../config";
import { fakeUpstream, errorResponse, completion, chunkFrame } from "../../testing/inference-harness";
import { classifyFetchError, createOpenAiCompatibleProvider, readTextLimited, UpstreamError, type ChatCall } from "./provider";
import { sanitizeChunk } from "./stream";

const endpoint = { id: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", secret: "GROQ_API_KEY" as const };
const signal = () => new AbortController().signal;
const call = (extra: Partial<ChatCall> = {}): ChatCall => ({
  upstreamModel: "openai/gpt-oss-120b",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
  maxTokens: 10,
  user: "u_abc",
  signal: signal(),
  ...extra,
});

function providerWith(handler: Parameters<typeof fakeUpstream>[0], apiKey = () => "sk-test-key") {
  const upstream = fakeUpstream(handler);
  return { provider: createOpenAiCompatibleProvider({ endpoint, fetch: upstream.fetch, apiKey, maxJsonBytes: 1000 }), calls: upstream.calls };
}

describe("UpstreamError", () => {
  it("is definitive only for an explicit error response, a redirect, a connection failure before acceptance and a missing key", () => {
    for (const kind of ["error_response", "redirect", "connect_failed", "unconfigured"] as const) expect(new UpstreamError(kind).definitive, kind).toBe(true);
    for (const kind of ["timeout", "aborted", "network", "malformed"] as const) expect(new UpstreamError(kind).definitive, kind).toBe(false);
  });

  it("never carries provider text in its message", () => {
    expect(new UpstreamError("error_response").message).toBe("upstream error_response");
  });
});

describe("classifyFetchError", () => {
  it("treats only a connect-time cause as before the request was accepted", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code } }), undefined).kind, code).toBe("connect_failed");
      expect(classifyFetchError(Object.assign(new Error("x"), { code }), undefined).kind, code).toBe("connect_failed");
    }
  });

  it("treats a reset, a generic network error and an unknown error as an unknown outcome", () => {
    expect(classifyFetchError(new TypeError("Network connection lost."), undefined).kind).toBe("network");
    expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), undefined).kind).toBe("network");
    expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }), undefined).kind).toBe("network");
    expect(classifyFetchError("weird", undefined).kind).toBe("network");
    expect(classifyFetchError(null, undefined).kind).toBe("network");
  });

  it("recognizes a timeout and an abort", () => {
    const timeout = new AbortController();
    timeout.abort(new DOMException("t", "TimeoutError"));
    expect(classifyFetchError(new Error("x"), timeout.signal).kind).toBe("timeout");
    const abort = new AbortController();
    abort.abort();
    expect(classifyFetchError(new Error("x"), abort.signal).kind).toBe("aborted");
    expect(classifyFetchError(new DOMException("a", "AbortError"), undefined).kind).toBe("aborted");
    expect(classifyFetchError(new DOMException("a", "TimeoutError"), undefined).kind).toBe("timeout");
  });
});

describe("the OpenAI-compatible provider", () => {
  it("calls the fixed chat path with a bearer key and no redirects", async () => {
    const { provider, calls } = providerWith(() => completion("ok", { prompt: 1, completion: 1 }));
    const res = await provider.chat(call());
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: "https://api.groq.com/openai/v1/chat/completions", method: "POST", redirect: "manual" });
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test-key");
    expect(calls[0]!.body).toEqual({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 10, user: "u_abc" });
  });

  it("builds the body from the structured call only: an extra property on the call object is not sent", async () => {
    const { provider, calls } = providerWith(() => completion("ok", { prompt: 1, completion: 1 }));
    const sneaky = { ...call(), tools: [{ type: "function" }], url: "https://evil.example", headers: { "X-Evil": "1" } } as ChatCall;
    await provider.chat(sneaky);
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["max_tokens", "messages", "model", "stream", "user"]);
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]!.headers["x-evil"]).toBeUndefined();
  });

  it("fails with a definitive error on a non-2xx status, cancelling the body unread", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode("provider secret text"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { provider } = providerWith(() => new Response(stream, { status: 429 }));
    const error = await provider.chat(call()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).kind).toBe("error_response");
    expect(String((error as Error).message)).not.toContain("secret");
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelled).toBe(true); // the provider's text is dropped, never mapped into an answer
  });

  it("does not follow a redirect, whatever the status", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { provider, calls } = providerWith(() => new Response(null, { status, headers: { Location: "https://evil.example/" } }));
      const error = (await provider.chat(call()).catch((e: unknown) => e)) as UpstreamError;
      expect(error.kind, String(status)).toBe("redirect");
      expect(error.definitive).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });

  it("is unconfigured, with nothing sent, when the key is missing", async () => {
    const { provider, calls } = providerWith(
      () => completion("x", null),
      () => {
        throw new ConfigError("missing secret GROQ_API_KEY");
      },
    );
    const error = (await provider.chat(call()).catch((e: unknown) => e)) as UpstreamError;
    expect(error.kind).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("classifies a fetch rejection by its moment", async () => {
    const refused = providerWith(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(((await refused.provider.chat(call()).catch((e: unknown) => e)) as UpstreamError).kind).toBe("connect_failed");
    const reset = providerWith(() => {
      throw new TypeError("Network connection lost.");
    });
    expect(((await reset.provider.chat(call()).catch((e: unknown) => e)) as UpstreamError).kind).toBe("network");
  });

  it("has no OCR: that provider is not chosen yet", () => {
    expect(providerWith(() => errorResponse(500)).provider.ocr).toBeUndefined();
  });
});

describe("readTextLimited", () => {
  it("reads a small body and refuses a large one without reading it all", async () => {
    expect(await readTextLimited(new Response("hello"), 100)).toBe("hello");
    let pulled = 0;
    const big = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(400));
        },
      }),
    );
    await expect(readTextLimited(big, 1000)).rejects.toMatchObject({ kind: "malformed" });
    expect(pulled).toBeLessThan(10);
  });

  it("refuses a declared length above the limit before reading", async () => {
    const res = new Response("x".repeat(10), { headers: { "Content-Length": "5000" } });
    await expect(readTextLimited(res, 100)).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("sanitizeChunk", () => {
  const parse = (frame: string) => JSON.parse(frame.slice(6)) as Record<string, unknown>;

  it("keeps the delta text and reasoning, rewrites the model and drops provider extensions", () => {
    const raw = parse(chunkFrame("hello"));
    (raw.choices as Array<Record<string, unknown>>)[0]!.delta = { role: "assistant", content: "hello", reasoning: "thinking", tool_calls: [{ id: "x" }], refusal: "no" };
    const { chunk, bytes } = sanitizeChunk(raw, "studentllm-large", "fallback", 1);
    expect(chunk).toEqual({
      id: "chatcmpl-upstream",
      object: "chat.completion.chunk",
      created: 1790000000,
      model: "studentllm-large",
      choices: [{ index: 0, delta: { role: "assistant", content: "hello", reasoning: "thinking" }, finish_reason: null }],
    });
    expect(bytes).toBe(5 + 8); // bytes, summed over the whole stream by the caller and converted once
  });

  it("returns no chunk for a usage-only or empty-choices chunk, and falls back for a missing id", () => {
    expect(sanitizeChunk({ choices: [], usage: {} }, "m", "f", 1).chunk).toBeNull();
    expect(sanitizeChunk({ x: 1 }, "m", "f", 1).chunk).toBeNull();
    const c = sanitizeChunk({ choices: [{ delta: { content: "a" } }] }, "m", "fallback-id", 42).chunk!;
    expect(c).toMatchObject({ id: "fallback-id", created: 42, object: "chat.completion.chunk" });
  });
});
