import { describe, expect, it } from "vitest";
import { expectFixtureConformance, loadFixture } from "../../testing";
import {
  ACCOUNT_ID,
  completion,
  errorResponse,
  makeInferenceHarness,
  SECRET_PROMPT,
  usageObject,
  type Harness,
  type UpstreamCall,
} from "../../testing/inference-harness";
import { DEFAULT_ROUTING, type RoutingConfig } from "./routing";

const body = (extra: Record<string, unknown> = {}) => ({
  model: "studentllm-large",
  messages: [
    { role: "system", content: "Answer from the provided course passages." },
    { role: "user", content: `Question ${SECRET_PROMPT}` },
  ],
  max_tokens: 512,
  ...extra,
});

/** No `max_tokens`: the reservation is for the model's whole output limit (4096 tokens, 27 credits). */
const bodyNoMax = () => {
  const { max_tokens: _omit, ...rest } = body();
  return rest;
};

const windowOf = async (h: Harness) => (await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now()))!;
const code = async (res: Response) => (await res.json()).error.code as string;

/** A routing table whose only model has a very short maximum duration, so a real timer can fire in a test. */
function fastTimeout(ms = 30): RoutingConfig {
  return { ...DEFAULT_ROUTING, models: [{ ...DEFAULT_ROUTING.models[0]!, maxDurationMs: ms }] };
}

/** An upstream that never answers until the gateway aborts the call. */
const hang = (call: UpstreamCall): Promise<Response> =>
  new Promise((_, reject) => call.signal?.addEventListener("abort", () => reject(call.signal!.reason), { once: true }));

describe("POST /v1/chat/completions, non-streaming", () => {
  it("answers with the logical model id, settles on the reported usage and sets the credit headers", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("EXAMPLE ANSWER", { prompt: 900, completion: 120 }) });
    const res = await h.chat(body());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.model).toBe("studentllm-large");
    expect(json.choices[0].message).toEqual({ role: "assistant", content: "EXAMPLE ANSWER" });
    expect(json.usage).toEqual({ prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 });
    // ceil((900 x 1620 + 120 x 6480) / 1e6) = ceil(2.2356) = 3 credits: rounded up once for the request.
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("3");
    expect(res.headers.get("X-StudentLLM-Credits-Limit")).toBe("15000");
    expect(res.headers.get("X-StudentLLM-Credits-Remaining")).toBe("14997");
    expect(res.headers.get("X-StudentLLM-Credits-Reset")).toBe("2026-12-01T00:00:00Z");
    expect(res.headers.get("X-StudentLLM-Plan-Version")).toBe("1");
    expect(await windowOf(h)).toMatchObject({ used: 3, reserved: 0, requests: 1 });
    // Provider extension fields do not reach the client.
    expect(JSON.stringify(json)).not.toContain("fp_secret_detail");
    expect(JSON.stringify(json)).not.toContain("req_provider_detail");
  });

  it("conforms to the success fixture", async () => {
    const fx = loadFixture("chat-completions.success");
    const h = makeInferenceHarness({ upstream: () => completion("EXAMPLE ANSWER", { prompt: 900, completion: 120 }) });
    await expectFixtureConformance(await h.chat(fx.request.body), fx);
  });

  it("counts reasoning tokens as output", async () => {
    // The provider reports 50 completion tokens and 3000 reasoning tokens on the side.
    const h = makeInferenceHarness({ upstream: () => completion("answer", { prompt: 100, completion: 50, reasoning: 3000 }) });
    const res = await h.chat(bodyNoMax());
    // output = 3000: ceil((100 x 1620 + 3000 x 6480) / 1e6) = ceil(19.602) = 20 (without reasoning it would be 1).
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("20");
  });

  it("settles at the full reservation when the answer carries no usage, and still returns the completion", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("answer without usage", null) });
    const res = await h.chat(bodyNoMax());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("answer without usage");
    expect(json.usage.total_tokens).toBeGreaterThan(0); // the schema requires usage: the gateway's own estimate
    const reserved = Number(res.headers.get("X-StudentLLM-Credits-Charged"));
    expect(reserved).toBeGreaterThan(20);
    expect(await windowOf(h)).toMatchObject({ used: reserved, reserved: 0 });
  });

  it("never charges more than the reservation, whatever the provider reports", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("x", { prompt: 50_000_000, completion: 50_000_000 }) });
    const res = await h.chat(body({ max_tokens: 10 }));
    const charged = Number(res.headers.get("X-StudentLLM-Credits-Charged"));
    // The reservation was made for ~30 input tokens and 10 output tokens: a couple of credits at most.
    expect(charged).toBeLessThanOrEqual(2);
    expect((await windowOf(h)).used).toBe(charged);
  });
});

describe("provider failures before any byte", () => {
  it("releases the reservation and answers provider_unavailable on an explicit 5xx (failed_no_usage)", async () => {
    const h = makeInferenceHarness({ upstream: () => errorResponse(503) });
    const res = await h.chat(body());
    await expectFixtureConformance(res.clone(), loadFixture("chat-completions.provider_unavailable.failed_no_usage"), {
      strictHeaders: ["Retry-After", "X-StudentLLM-Credits-Charged"],
    });
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
    // The provider's text is mapped to a fixed code and never returned.
    expect(await res.text()).not.toContain("provider detail");
  });

  it("lets the same key retry after a failed_no_usage, with a new request id", async () => {
    let n = 0;
    const h = makeInferenceHarness({ upstream: () => (++n === 1 ? errorResponse(500) : completion("ok", { prompt: 10, completion: 5 })) });
    const key = h.key();
    expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(503);
    const retry = await h.chat(body(), { "Idempotency-Key": key });
    expect(retry.status).toBe(200);
    expect(h.upstreamCalls).toHaveLength(2);
    // And now the key is settled.
    const again = await h.chat(body(), { "Idempotency-Key": key });
    expect(again.status).toBe(409);
    expect((await again.json()).error.details.state).toBe("settled");
  });

  it("counts failed_no_usage events per account and hour (the anomaly signal)", async () => {
    const h = makeInferenceHarness({ upstream: () => errorResponse(500) });
    await h.chat(body());
    await h.chat(body());
    expect(await h.stores.idempotency.failedNoUsageCount(ACCOUNT_ID, Math.floor(h.clock.now() / 3_600_000))).toBe(2);
  });

  it("treats a connection failure before the request was accepted as failed_no_usage", async () => {
    const h = makeInferenceHarness({
      upstream: () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("treats a redirect as a failure and never follows it", async () => {
    const h = makeInferenceHarness({ upstream: () => new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } }) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(h.upstreamCalls).toHaveLength(1);
    expect(h.upstreamCalls[0]!.redirect).toBe("manual");
    expect(await windowOf(h)).toMatchObject({ used: 0 });
  });

  it("treats a 200 whose body is an error as a failure with no completion", async () => {
    const h = makeInferenceHarness({ upstream: () => new Response(JSON.stringify({ error: { message: "model overloaded" } }), { status: 200 }) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
  });
});

describe("unknown outcomes are charged in full", () => {
  it("settles a timeout at the full reservation, and the same-key retry gets idempotency_conflict settled", async () => {
    const h = makeInferenceHarness({ routing: fastTimeout(), upstream: hang });
    const key = h.key();
    const res = await h.chat(bodyNoMax(), { "Idempotency-Key": key });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("provider_unavailable");
    const charged = Number(res.headers.get("X-StudentLLM-Credits-Charged"));
    expect(charged).toBeGreaterThan(20); // not the 3 credits the answer would have cost: the whole reservation
    expect(await windowOf(h)).toMatchObject({ used: charged, reserved: 0 });

    const retry = await h.chat(bodyNoMax(), { "Idempotency-Key": key });
    await expectFixtureConformance(retry.clone(), loadFixture("chat-completions.idempotency_conflict.after_timeout"));
    expect((await retry.json()).error.details.credits_charged).toBe(charged);
    expect(h.upstreamCalls).toHaveLength(1);
  });

  it("settles a network error of unknown moment (a reset) at the full reservation", async () => {
    const h = makeInferenceHarness({
      upstream: () => {
        throw new TypeError("Network connection lost.");
      },
    });
    const res = await h.chat(bodyNoMax());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
  });

  it("settles a 200 whose body cannot be read at the full reservation", async () => {
    const h = makeInferenceHarness({ upstream: () => new Response("<html>not json</html>", { status: 200 }) });
    const res = await h.chat(bodyNoMax());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
    expect(await windowOf(h)).toMatchObject({ reserved: 0 });
  });

  it("settles an oversized upstream body at the full reservation without buffering it", async () => {
    const h = makeInferenceHarness({
      settings: { maxUpstreamBodyBytes: 2048 },
      upstream: () => new Response("x".repeat(100_000), { status: 200 }),
    });
    const res = await h.chat(bodyNoMax());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
  });
});

describe("failover inside the consented provider set", () => {
  const twoProviders: RoutingConfig = {
    providers: [...DEFAULT_ROUTING.providers, { id: "groq2", displayName: "Groq (second)", baseUrl: "https://api2.example.invalid/v1", secret: "GROQ_API_KEY" }],
    providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, providerIds: ["groq", "groq2"] }],
    models: [
      {
        ...DEFAULT_ROUTING.models[0]!,
        targets: [
          { providerId: "groq", upstreamModel: "openai/gpt-oss-120b" },
          { providerId: "groq2", upstreamModel: "gpt-oss-120b" },
        ],
      },
    ],
  };

  it("tries the next provider of the set after a definitive failure", async () => {
    const h = makeInferenceHarness({
      routing: twoProviders,
      upstream: (call) => (call.url.startsWith("https://api.groq.com") ? errorResponse(500) : completion("ok", { prompt: 10, completion: 5 })),
    });
    const res = await h.chat(body());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls.map((c) => new URL(c.url).host)).toEqual(["api.groq.com", "api2.example.invalid"]);
    expect(h.upstreamCalls[1]!.body.model).toBe("gpt-oss-120b");
  });

  it("does NOT fail over after an unknown outcome (the first provider may have produced a completion)", async () => {
    const h = makeInferenceHarness({
      routing: { ...twoProviders, models: [{ ...twoProviders.models[0]!, maxDurationMs: 30 }] },
      upstream: hang,
    });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(h.upstreamCalls).toHaveLength(1);
  });

  it("answers provider_unavailable and releases when every provider of the set failed", async () => {
    const h = makeInferenceHarness({ routing: twoProviders, upstream: () => errorResponse(502) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(h.upstreamCalls).toHaveLength(2);
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("refuses a routing table that routes outside its provider set", () => {
    expect(() =>
      makeInferenceHarness({ routing: { ...twoProviders, providerSets: [{ ...twoProviders.providerSets[0]!, providerIds: ["groq"] }] } }),
    ).toThrow(/outside its provider set/);
  });
});

describe("the request that reaches the upstream (SSRF and the body allowlist)", () => {
  it("goes to the fixed endpoint of the routing table with only the headers the gateway sets", async () => {
    const h = makeInferenceHarness();
    const res = await h.chat(body({ stream: false }), {
      "X-Forwarded-Host": "evil.example",
      "X-Evil": "1",
      Host: "evil.example",
    });
    expect(res.status).toBe(200);
    const call = h.upstreamCalls[0]!;
    expect(call.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.redirect).toBe("manual");
    expect(Object.keys(call.headers).sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(call.headers.authorization).toMatch(/^Bearer test-only-groq_api_key-/);
    expect(JSON.stringify(call.headers)).not.toContain("evil");
    expect(JSON.stringify(call.headers)).not.toContain("eyJhbGciOiJFZERTQSJ9"); // the client's own token
  });

  it("rewrites the model, sets the pseudonym as `user` and sends nothing the allowlist does not name", async () => {
    const h = makeInferenceHarness();
    await h.chat(body({ stream: false, temperature: 0.2, top_p: 0.9, stop: ["END"], reasoning_effort: "low", response_format: { type: "json_object", evil: "x" } }));
    const sent = h.upstreamCalls[0]!.body;
    expect(Object.keys(sent).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "response_format", "stop", "stream", "temperature", "top_p", "user"]);
    expect(sent.model).toBe("openai/gpt-oss-120b");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.user).toMatch(/^u_[A-Za-z0-9_-]{32}$/);
    expect(sent.user).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(sent)).not.toContain("student@example.invalid");
    // The same account always maps to the same pseudonym.
    await h.chat(body());
    expect(h.upstreamCalls[1]!.body.user).toBe(sent.user);
  });

  it("forces usage on streamed responses", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("x", { prompt: 1, completion: 1 }) });
    await h.chat(body({ stream: true })).catch(() => undefined);
    expect(h.upstreamCalls[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  it("clamps max_tokens to the model limit, and defaults to it", async () => {
    const h = makeInferenceHarness();
    await h.chat(body({ max_tokens: 99_999 }));
    await h.chat(body({ max_tokens: 100 }));
    await h.chat(bodyNoMax());
    expect(h.upstreamCalls.map((c) => c.body.max_tokens)).toEqual([4096, 100, 4096]);
  });

  it("accepts n equal to 1", async () => {
    const h = makeInferenceHarness();
    expect((await h.chat(body({ n: 1 }))).status).toBe(200);
    expect(h.upstreamCalls[0]!.body.n).toBeUndefined();
  });

  const REJECTED: Array<[string, Record<string, unknown>]> = [
    ["tools", { tools: [{ type: "function", function: { name: "x" } }] }],
    ["tool_choice", { tool_choice: "auto" }],
    ["functions", { functions: [] }],
    ["function_call", { function_call: "auto" }],
    ["n above 1", { n: 2 }],
    ["logit_bias", { logit_bias: { "50256": -100 } }],
    ["user", { user: "someone" }],
    ["stream_options", { stream_options: { include_usage: false } }],
    ["an unknown field", { frequency_penalty: 1 }],
    ["a provider-specific field", { service_tier: "flex" }],
    ["max_tokens as a string", { max_tokens: "100" }],
    ["temperature out of range", { temperature: 3 }],
    ["a model that is a URL", { model: "https://evil.example/v1/chat" }],
    ["an upstream model id", { model: "openai/gpt-oss-120b" }],
    ["an unknown model", { model: "nope" }],
  ];
  for (const [name, extra] of REJECTED) {
    it(`rejects ${name} with invalid_request, reserves nothing and sends nothing upstream`, async () => {
      const h = makeInferenceHarness();
      const key = h.key();
      const res = await h.chat(body(extra), { "Idempotency-Key": key });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("invalid_request");
      expect(h.upstreamCalls).toHaveLength(0);
      expect(await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now())).toBeNull(); // not even a lazy window
      // The key is free again: a corrected request with the same key goes through.
      expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(200);
    });
  }

  it("rejects an http(s) image URL and, for a text-only model, any image", async () => {
    const h = makeInferenceHarness();
    const withImage = (url: string) => body({ messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url } }] }] });
    expect((await h.chat(withImage("https://evil.example/cat.png"))).status).toBe(400);
    expect((await h.chat(withImage("data:image/png;base64,iVBORw0KGgo="))).status).toBe(400); // text-only model
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("does not echo the offending value in the error", async () => {
    const h = makeInferenceHarness();
    const res = await h.chat(body({ [`field_${SECRET_PROMPT}`]: SECRET_PROMPT }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SECRET_PROMPT);
  });
});

describe("usage objects", () => {
  it("normalizes odd usage numbers conservatively", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("x", null, { usage: { prompt_tokens: -5, completion_tokens: 10, total_tokens: 5 } }) });
    const res = await h.chat(bodyNoMax());
    // A negative number is malformed usage: the full reservation, not a cheap guess.
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
    void usageObject;
  });
});
