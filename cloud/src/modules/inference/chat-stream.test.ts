import { describe, expect, it, vi } from "vitest";
import { expectFixtureConformance, loadFixture, parseSse, type SseEvent } from "../../testing";
import {
  ACCOUNT_ID,
  chunkFrame,
  DONE_FRAME,
  errorResponse,
  makeInferenceHarness,
  manualSse,
  SECRET_PROMPT,
  sseResponse,
  usageFrame,
  type Harness,
} from "../../testing/inference-harness";
import { DEFAULT_ROUTING, type RoutingConfig } from "./routing";

const body = (extra: Record<string, unknown> = {}) => ({
  model: "studentllm-large",
  messages: [{ role: "user", content: `Question ${SECRET_PROMPT}` }],
  stream: true,
  ...extra,
});

const windowOf = async (h: Harness) => (await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now()))!;
const shape = (events: SseEvent[]) => events.map((e) => e.event ?? (e.data === "[DONE]" ? "done" : "chunk"));

function fastTimeout(ms = 40): RoutingConfig {
  return { ...DEFAULT_ROUTING, models: [{ ...DEFAULT_ROUTING.models[0]!, maxDurationMs: ms }] };
}

const FULL_OUTPUT_RESERVATION = 27; // no max_tokens: 4096 output tokens reserved

describe("stream passthrough", () => {
  it("rewrites the model, drops provider extensions and emits the events in contract order", async () => {
    const h = makeInferenceHarness({
      upstream: () => sseResponse([chunkFrame("Hello"), chunkFrame(" world", "stop"), usageFrame({ prompt: 100, completion: 20 }), DONE_FRAME]),
    });
    const text = await (await h.chat(body())).text();
    expect(shape(parseSse(text))).toEqual(["chunk", "chunk", "usage", "done"]);
    expect(text).not.toContain("openai/gpt-oss-120b");
    expect(text).not.toContain("req_provider_detail");
    expect(text).not.toContain('"usage":{"prompt_tokens"'); // the upstream usage chunk is not forwarded
  });

  it("holds the concurrency slot until the stream ends", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("a"), chunkFrame("b"), usageFrame({ prompt: 1, completion: 1 }), DONE_FRAME]) });
    const res = await h.chat(body());
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(1);
    await res.text();
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
  });

  it("sets the meter after the reservation in the headers, and the settled one in the usage event", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("a"), usageFrame({ prompt: 10, completion: 10 }), DONE_FRAME]) });
    const res = await h.chat(body());
    // Reserved for the whole output limit.
    expect(Number(res.headers.get("X-StudentLLM-Credits-Remaining"))).toBe(12500 - FULL_OUTPUT_RESERVATION);
    expect(res.headers.get("X-StudentLLM-Credits-Limit")).toBe("12500");
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBeNull(); // streams use the usage event
    const events = parseSse(await res.text());
    expect(JSON.parse(events.find((e) => e.event === "usage")!.data)).toMatchObject({ credits_charged: 1, credits_remaining: 12499 });
  });
});

describe("failures before the first byte of a stream use the normal HTTP error", () => {
  it("answers 503 and releases when the provider answers 5xx", async () => {
    const h = makeInferenceHarness({ upstream: () => errorResponse(500) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("answers 503 and releases when the very first event is an error", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([`data: {"error":{"message":"overloaded"}}\n\n`]) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("charges the full reservation when the connection drops before any byte of content", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([], { end: "reset" }) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
    expect(await windowOf(h)).toMatchObject({ used: Number(res.headers.get("X-StudentLLM-Credits-Charged")), reserved: 0 });
  });

  it("charges the full reservation when an empty 200 answer ends with nothing", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([]) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
  });
});

describe("failover for a stream inside the consented provider set", () => {
  const twoProviders: RoutingConfig = {
    providers: [...DEFAULT_ROUTING.providers, { id: "groq2", displayName: "Groq (second)", baseUrl: "https://api2.example.invalid/v1", secret: "GROQ_API_KEY" }],
    providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, providerIds: ["groq", "groq2"] }],
    models: [
      {
        ...DEFAULT_ROUTING.models[0]!,
        maxDurationMs: 5000,
        targets: [
          { providerId: "groq", upstreamModel: "openai/gpt-oss-120b" },
          { providerId: "groq2", upstreamModel: "gpt-oss-120b" },
        ],
      },
    ],
  };
  const good = () => sseResponse([chunkFrame("from the second provider"), usageFrame({ prompt: 10, completion: 10 }), DONE_FRAME]);

  it("moves to the next provider when the first answers 5xx or sends an error as its first event", async () => {
    for (const failing of [() => errorResponse(500), () => sseResponse([`data: {"error":{"message":"overloaded"}}\n\n`])]) {
      const h = makeInferenceHarness({ routing: twoProviders, upstream: (call) => (call.url.startsWith("https://api.groq.com") ? failing() : good()) });
      const text = await (await h.chat(body())).text();
      expect(shape(parseSse(text))).toEqual(["chunk", "usage", "done"]);
      expect(h.upstreamCalls).toHaveLength(2);
      expect((await windowOf(h)).used).toBe(1); // charged once, on the second provider's usage
    }
  });

  it("does not move on after an unknown outcome before the first byte (the first provider may have answered)", async () => {
    const h = makeInferenceHarness({ routing: twoProviders, upstream: (call) => (call.url.startsWith("https://api.groq.com") ? sseResponse([], { end: "reset" }) : good()) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(h.upstreamCalls).toHaveLength(1);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
  });
});

describe("failures after the first byte: one error event, no [DONE]", () => {
  it("conforms to the mid-stream error fixture and settles on the tokens emitted", async () => {
    const fx = loadFixture("chat-completions.stream.mid_stream_error");
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("EXAM"), `data: {"error":{"message":"stopped"}}\n\n`]) });
    const res = await h.chat({ ...(fx.request.body as object), max_tokens: undefined });
    await expectFixtureConformance(res.clone(), fx);
    const events = parseSse(await res.text());
    expect(shape(events)).toEqual(["chunk", "error"]);
    expect(JSON.parse(events[1]!.data).error.code).toBe("provider_unavailable");
    // "EXAM" is 4 bytes = 2 estimated tokens, plus the input estimate: a credit or two, not the reservation.
    const w = await windowOf(h);
    expect(w.reserved).toBe(0);
    expect(w.used).toBeGreaterThanOrEqual(1);
    expect(w.used).toBeLessThan(5);
  });

  it("falls back to the full reservation when nothing was emitted before the error", async () => {
    const roleOnly = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`;
    const h = makeInferenceHarness({ upstream: () => sseResponse([roleOnly, `data: {"error":{"message":"stopped"}}\n\n`]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "error"]);
    expect((await windowOf(h)).used).toBeGreaterThan(20);
  });

  it("charges the full reservation when the connection is reset mid-stream", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("some text")], { end: "reset" }) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "error"]);
    expect((await windowOf(h)).used).toBeGreaterThan(20);
  });

  it("charges the full reservation when the stream ends with neither [DONE] nor usage", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("some text")]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "error"]); // a stream with neither [DONE] nor an error would be a network failure
    expect((await windowOf(h)).used).toBeGreaterThan(20);
  });

  it("times out mid-stream: the gateway's timer ends it with an error event, settled in full", async () => {
    const h = makeInferenceHarness({
      routing: fastTimeout(),
      upstream: (call) => sseResponse([chunkFrame("first token")], { end: "hang", signal: call.signal }),
    });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "error"]);
    expect((await windowOf(h)).used).toBeGreaterThan(20);
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
  });

  it("times out even when the upstream body ignores the abort signal", async () => {
    const h = makeInferenceHarness({
      routing: fastTimeout(),
      upstream: () => sseResponse([chunkFrame("first token")], { end: "hang", signal: null }),
    });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "error"]);
  });

  it("treats malformed event data as a provider failure and counts what was emitted", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("good text here"), "data: {this is not json\n\n", chunkFrame("never sent")]) });
    const text = await (await h.chat(body())).text();
    expect(shape(parseSse(text))).toEqual(["chunk", "error"]);
    expect(text).not.toContain("never sent");
    const used = (await windowOf(h)).used;
    expect(used).toBeGreaterThanOrEqual(1);
    expect(used).toBeLessThan(5);
  });

  it("treats an event larger than the buffer limit as malformed", async () => {
    const h = makeInferenceHarness({
      settings: { maxSseEventBytes: 1024 },
      upstream: () => sseResponse([chunkFrame("ok"), `data: ${"x".repeat(5000)}`]),
    });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "error"]);
  });

  it("treats malformed data in the first event as a failure before the first byte", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse(["data: <html>gateway error</html>\n\n"]) });
    const res = await h.chat(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
  });
});

describe("the end of a stream", () => {
  it("settles at the full reservation when no usage chunk arrives, and still ends with usage and [DONE]", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("answer"), chunkFrame("", "stop"), DONE_FRAME]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "chunk", "usage", "done"]);
    const usage = JSON.parse(events[2]!.data);
    expect(usage.credits_charged).toBeGreaterThan(20);
    expect((await windowOf(h)).used).toBe(usage.credits_charged);
  });

  it("settles on the usage when [DONE] is missing but the usage arrived", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("answer"), usageFrame({ prompt: 100, completion: 20 })]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "usage", "done"]);
    expect(JSON.parse(events[1]!.data).credits_charged).toBe(1);
  });

  it("counts reasoning tokens as output on a stream too", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("answer"), usageFrame({ prompt: 100, completion: 50, reasoning: 3000 }), DONE_FRAME]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(JSON.parse(events.find((e) => e.event === "usage")!.data).credits_charged).toBe(20);
  });

  it("settles at the full reservation when the usage is malformed", async () => {
    const bad = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: "many" } })}\n\n`;
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("answer"), bad, DONE_FRAME]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(JSON.parse(events.find((e) => e.event === "usage")!.data).credits_charged).toBeGreaterThan(20);
  });

  it("copes with events split across chunks and CRLF line endings", async () => {
    const frame = chunkFrame("split across chunks").replace(/\n/g, "\r\n");
    const h = makeInferenceHarness({ upstream: () => sseResponse([frame.slice(0, 20), frame.slice(20, 60), frame.slice(60), usageFrame({ prompt: 5, completion: 5 }).replace(/\n/g, "\r\n"), "data: [DONE]\r\n\r\n"]) });
    const events = parseSse(await (await h.chat(body())).text());
    expect(shape(events)).toEqual(["chunk", "usage", "done"]);
    expect(JSON.parse(events[0]!.data).choices[0].delta.content).toBe("split across chunks");
  });
});

describe("the client leaves", () => {
  it("settles an abort after the first token at the full reservation, tied to waitUntil, and frees the slot", async () => {
    const h = makeInferenceHarness({
      upstream: (call) => sseResponse([chunkFrame("first token")], { end: "hang", signal: call.signal }),
    });
    const key = h.key();
    const res = await h.chatWith(body(), { "Idempotency-Key": key });
    const reader = res.body!.getReader();
    await reader.read(); // the first token
    await reader.cancel();
    await h.executionCtx.settled();

    const w = await windowOf(h);
    expect(w.reserved).toBe(0);
    expect(w.used).toBeGreaterThan(20);
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
    // The key is settled: the retry is an idempotency_conflict, not a second charge.
    const retry = await h.chat(body({ stream: false }), { "Idempotency-Key": key });
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.details).toMatchObject({ state: "settled", credits_charged: w.used });
  });

  it("settles exactly once even if the client cancels while the gateway is reading", async () => {
    const h = makeInferenceHarness({
      upstream: (call) => sseResponse([chunkFrame("first token")], { end: "hang", signal: call.signal }),
    });
    const res = await h.chatWith(body(), undefined);
    const reader = res.body!.getReader();
    await reader.read();
    const pending = reader.read(); // a read in flight while the cancel arrives
    await reader.cancel();
    await pending.catch(() => undefined);
    await h.executionCtx.settled();
    expect(await h.stores.ledger.doubleSettlementCount(ACCOUNT_ID)).toBe(0);
    expect((await windowOf(h)).requests).toBe(1);
  });
});

describe("the first settlement wins", () => {
  it("reports what the sweep already charged when the stream finishes after its reservation expired", async () => {
    const upstream = manualSse();
    upstream.push(chunkFrame("slow"));
    const h = makeInferenceHarness({ upstream: () => upstream.response });
    const res = await h.chat(body());
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    // Ten minutes pass with no heartbeat (the stream stalled). The cron sweep finds the forwarded reservation
    // expired: an unknown outcome, charged in full.
    h.clock.advance(10 * 60_000);
    const { sweepAccount } = await import("./sweeper");
    await sweepAccount(h.t.deps, ACCOUNT_ID);
    const sweptUsed = (await windowOf(h)).used;
    expect(sweptUsed).toBeGreaterThan(20);

    // The provider finishes after all, with a small real usage.
    upstream.push(usageFrame({ prompt: 10, completion: 10 }));
    upstream.push(DONE_FRAME);
    upstream.close();
    let rest = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest += new TextDecoder().decode(r.value);
    }
    const usage = JSON.parse(parseSse(rest).find((e) => e.event === "usage")!.data);
    expect(usage.credits_charged).toBe(sweptUsed); // the first settlement (the sweep) won, and the stream says so
    expect(await h.stores.ledger.doubleSettlementCount(ACCOUNT_ID)).toBe(1);
    expect((await windowOf(h)).used).toBe(sweptUsed);
  });
});

describe("the heartbeat", () => {
  it("extends the reservation and renews the concurrency lease while a stream makes progress", async () => {
    const upstream = manualSse();
    upstream.push(chunkFrame("a"));
    const h = makeInferenceHarness({ upstream: () => upstream.response });
    const t0 = h.clock.now();
    const res = await h.chat(body());
    const reader = res.body!.getReader();
    await reader.read();
    const requestId = "req_test_000001";
    const initial = (await h.stores.ledger.getReservation(ACCOUNT_ID, requestId))!;
    expect(initial.expiresAt).toBe(t0 + 120_000 + 60_000); // the route's max duration plus 60 s

    // 100 seconds later the stream is still making progress: both are pushed out.
    h.clock.advance(100_000);
    upstream.push(chunkFrame("b"));
    await reader.read();
    const extended = (await h.stores.ledger.getReservation(ACCOUNT_ID, requestId))!;
    expect(extended.expiresAt).toBe(t0 + 100_000 + 120_000 + 60_000);
    // The lease of the first TTL (180 s) would have run out at +180 s; at +190 s it is still held.
    h.clock.advance(90_000);
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(1);

    await reader.cancel();
    await h.executionCtx.settled();
  });

  it("does not extend a reservation more often than the heartbeat interval", async () => {
    const upstream = manualSse();
    upstream.push(chunkFrame("a"));
    const h = makeInferenceHarness({ upstream: () => upstream.response });
    const res = await h.chat(body());
    const reader = res.body!.getReader();
    await reader.read();
    const before = (await h.stores.ledger.getReservation(ACCOUNT_ID, "req_test_000001"))!.expiresAt;
    h.clock.advance(5_000);
    upstream.push(chunkFrame("b"));
    await reader.read();
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_test_000001"))!.expiresAt).toBe(before);
    await reader.cancel();
    await h.executionCtx.settled();
  });
});

describe("logging", () => {
  it("does not log or store the prompt or the answer, also on the failure paths", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const scenarios: Array<() => Promise<void>> = [
      async () => void (await makeInferenceHarness({ upstream: () => sseResponse([chunkFrame(SECRET_PROMPT), usageFrame({ prompt: 1, completion: 1 }), DONE_FRAME]) }).chat(body())).text(),
      async () => void (await makeInferenceHarness({ upstream: () => sseResponse([chunkFrame(SECRET_PROMPT), "data: {broken\n\n"]) }).chat(body())).text(),
    ];
    for (const run of scenarios) await run();
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame(SECRET_PROMPT)], { end: "reset" }) });
    await (await h.chat(body())).text();
    const { dumpStores } = await import("../../testing/inference-harness");
    expect(dumpStores(h.stores)).not.toContain(SECRET_PROMPT);
    expect(dumpStores(h.stores)).not.toContain("Question");
    expect(JSON.stringify(h.t.logs)).not.toContain(SECRET_PROMPT);
    const printed = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
    expect(printed).not.toContain(SECRET_PROMPT);
    for (const s of spies) s.mockRestore();
  });
});
