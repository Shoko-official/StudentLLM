// Findings of the independent review of the first version: a hostile usage must not leave a reservation open, a consent
// is looked at again right before the reservation, a provider that bills its 4xx answers is configurable, and the
// unknown outcomes charged in full are counted.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSse } from "../../testing";
import {
  ACCOUNT_ID,
  chunkFrame,
  completion,
  DONE_FRAME,
  errorResponse,
  makeInferenceHarness,
  manualSse,
  SECRET_PROMPT,
  sseResponse,
  usageFrame,
  type Harness,
} from "../../testing/inference-harness";
import { dayPeriod } from "./availability";
import { DEFAULT_ROUTING } from "./routing";

const body = (extra: Record<string, unknown> = {}) => ({
  model: "studentllm-large",
  messages: [{ role: "user", content: `Question ${SECRET_PROMPT}` }],
  ...extra,
});
const noMax = () => body();
const windowOf = async (h: Harness) => (await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now()))!;
const shape = (text: string) => parseSse(text).map((e) => e.event ?? (e.data === "[DONE]" ? "done" : "chunk"));
const counter = (h: Harness, name: string) => h.stores.switches.getCounter(name, dayPeriod(h.clock.now()));

/** A usage frame carrying `usage` as raw JSON text, so that values like 1e999 (Infinity) can be sent. */
const rawUsageFrame = (usageJson: string) =>
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":${usageJson}}\n\n`;

const HOSTILE_USAGES = [
  ["a count above the context window", '{"prompt_tokens":200000,"completion_tokens":5}'],
  ["counts whose sum overflows", '{"prompt_tokens":4503599627370495,"completion_tokens":4503599627370495}'],
  ["an infinite count", '{"prompt_tokens":1e999,"completion_tokens":1}'],
  ["a huge reasoning count", '{"prompt_tokens":10,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":9007199254740991}}'],
  ["a huge total", '{"prompt_tokens":10,"completion_tokens":5,"total_tokens":9007199254740991}'],
] as const;

describe("a hostile or absurd usage does not leave a reservation open", () => {
  for (const [name, usage] of HOSTILE_USAGES) {
    it(`stream, ${name}: one error event, no [DONE], settled in full, the slot freed`, async () => {
      const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("answer"), rawUsageFrame(usage), DONE_FRAME]) });
      const text = await (await h.chat(body({ stream: true }))).text();
      expect(shape(text)).toEqual(["chunk", "error"]);
      expect(JSON.parse(parseSse(text)[1]!.data).error.code).toBe("provider_unavailable");
      const w = await windowOf(h);
      expect(w.reserved).toBe(0); // nothing left reserved
      expect(w.used).toBeGreaterThan(20); // the whole reservation, not a guess from absurd numbers
      expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
    });

    it(`non-stream, ${name}: 503 provider_unavailable (not a 500), settled in full`, async () => {
      const h = makeInferenceHarness({
        upstream: () => new Response(`{"id":"c","object":"chat.completion","created":1,"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"stop"}],"usage":${usage}}`, { status: 200 }),
      });
      const res = await h.chat(noMax());
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("provider_unavailable");
      expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
      expect(await windowOf(h)).toMatchObject({ reserved: 0 });
    });
  }

  it("a usage inside the window is still honored", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 131_000, completion: 70 }) });
    expect((await h.chat(body())).status).toBe(200);
  });

  it("a stream whose settlement itself fails still ends, frees the slot and does not hang", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("answer"), usageFrame({ prompt: 5, completion: 5 }), DONE_FRAME]) });
    const realSettle = h.stores.ledger.settle.bind(h.stores.ledger);
    let calls = 0;
    h.stores.ledger.settle = async (accountId, input) => {
      if (++calls === 1) throw new Error("store down");
      return realSettle(accountId, input);
    };
    const text = await (await h.chat(body({ stream: true }))).text(); // resolves: no hang
    expect(shape(text)).toEqual(["chunk", "error"]);
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
  });

  it("an unexpected exception inside the stream settles in full and tells the client", async () => {
    const upstream = manualSse();
    upstream.push(chunkFrame("answer"));
    const h = makeInferenceHarness({ upstream: () => upstream.response });
    // The heartbeat writes to the ledger: make that fail in the middle of the stream.
    h.stores.ledger.extendReservation = async () => {
      throw new Error("store down");
    };
    const res = await h.chat(body({ stream: true }));
    const reader = res.body!.getReader();
    await reader.read(); // the first chunk
    h.clock.advance(60_000); // the next chunk is past the heartbeat interval
    upstream.push(chunkFrame("more"));
    let text = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      text += new TextDecoder().decode(r.value);
    }
    expect(shape(text)).toEqual(["chunk", "error"]);
    const w = await windowOf(h);
    expect(w.reserved).toBe(0);
    expect(w.used).toBeGreaterThan(20); // an unexpected failure is an unknown outcome: the whole reservation
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
  });
});

describe("a stream that fails in the middle is settled on a tight count", () => {
  it("does not bill a token per tiny delta", async () => {
    // 4000 one-byte deltas, then an explicit provider error.
    const deltas = Array.from({ length: 4000 }, () => chunkFrame("a"));
    const h = makeInferenceHarness({ upstream: () => sseResponse([...deltas, `data: {"error":{"message":"stopped"}}\n\n`]) });
    await (await h.chat(noMax_stream())).text();
    // 4000 bytes at 2 bytes a token = 2000 tokens (about 13 credits); rounding up per delta would be 4000 tokens (26).
    const used = (await windowOf(h)).used;
    expect(used).toBeGreaterThanOrEqual(13);
    expect(used).toBeLessThanOrEqual(14);
  });
});

function noMax_stream() {
  return { ...noMax(), stream: true };
}

describe("the consent is looked at again right before the reservation", () => {
  it("stops a request whose consent was withdrawn while its body was arriving", async () => {
    const h = makeInferenceHarness();
    const real = h.stores.consents.getActive.bind(h.stores.consents);
    let calls = 0;
    // The hook (before the body) sees the active record; by the time of the reservation it has been withdrawn.
    h.stores.consents.getActive = async (accountId, providerSetId) => (++calls === 1 ? real(accountId, providerSetId) : null);
    const key = h.key();
    const res = await h.chat(body(), { "Idempotency-Key": key });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("consent_outdated");
    expect(calls).toBe(2);
    expect(h.upstreamCalls).toHaveLength(0);
    expect(await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now())).toBeNull(); // nothing reserved
    h.stores.consents.getActive = real;
    expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(200); // the key is usable again
  });

  it("stops a request whose consent was replaced by another record in that time", async () => {
    const h = makeInferenceHarness();
    const real = h.stores.consents.getActive.bind(h.stores.consents);
    let calls = 0;
    h.stores.consents.getActive = async (accountId, providerSetId) => {
      const active = await real(accountId, providerSetId);
      return ++calls === 1 || !active ? active : { ...active, consentId: "cns_newer" };
    };
    expect((await h.chat(body())).status).toBe(409);
    expect(h.upstreamCalls).toHaveLength(0);
  });
});

describe("a provider that bills its 4xx answers", () => {
  const billing = (flag: boolean | undefined) => ({
    ...DEFAULT_ROUTING,
    providers: [{ ...DEFAULT_ROUTING.providers[0]!, ...(flag === undefined ? {} : { clientErrorMayBeBilled: flag }) }],
  });

  it("by default a 4xx is an explicit error: released, zero credits", async () => {
    const h = makeInferenceHarness({ routing: billing(undefined), upstream: () => errorResponse(400) });
    const res = await h.chat(noMax());
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("with the flag a 4xx is an unknown outcome: the full reservation, and counted", async () => {
    const h = makeInferenceHarness({ routing: billing(true), upstream: () => errorResponse(400) });
    const res = await h.chat(noMax());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
    expect(await counter(h, "upstream_unknown_billable_error")).toBe(1);
  });

  it("with the flag a 5xx and a redirect are still definitive", async () => {
    for (const response of [() => errorResponse(503), () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })]) {
      const h = makeInferenceHarness({ routing: billing(true), upstream: response });
      const res = await h.chat(noMax());
      expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
    }
  });

  it("the flag applies to a stream's 4xx too", async () => {
    const h = makeInferenceHarness({ routing: billing(true), upstream: () => errorResponse(422) });
    const res = await h.chat({ ...noMax(), stream: true });
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("X-StudentLLM-Credits-Charged"))).toBeGreaterThan(20);
  });
});

describe("unknown outcomes charged in full are counted, by kind and day", () => {
  it("counts a network error with no usable cause (a Workers fetch rejection)", async () => {
    const h = makeInferenceHarness({
      upstream: () => {
        throw new TypeError("Network connection lost.");
      },
    });
    await h.chat(noMax());
    await h.chat(noMax());
    expect(await counter(h, "upstream_unknown_network")).toBe(2);
  });

  it("counts a timeout under its own name, and a reset in the middle of a stream", async () => {
    const hung = makeInferenceHarness({
      routing: { ...DEFAULT_ROUTING, models: [{ ...DEFAULT_ROUTING.models[0]!, maxDurationMs: 30 }] },
      upstream: (call) => new Promise((_, reject) => call.signal?.addEventListener("abort", () => reject(call.signal!.reason), { once: true })),
    });
    await hung.chat(noMax());
    expect(await counter(hung, "upstream_unknown_timeout")).toBe(1);
    const reset = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("text")], { end: "reset" }) });
    await (await reset.chat({ ...noMax(), stream: true })).text();
    expect(await counter(reset, "upstream_unknown_network")).toBe(1);
  });

  it("does not count a definitive failure, a success or a counted-token settlement", async () => {
    const h = makeInferenceHarness({ upstream: () => errorResponse(500) });
    await h.chat(noMax());
    expect(await counter(h, "upstream_unknown_network")).toBe(0);
    expect(await counter(h, "upstream_unknown_error_response")).toBe(0);
  });

  it("keeps the days apart", async () => {
    const h = makeInferenceHarness({
      upstream: () => {
        throw new TypeError("Network connection lost.");
      },
    });
    await h.chat(noMax());
    const today = dayPeriod(h.clock.now());
    h.clock.advance(24 * 3_600_000);
    await h.chat(noMax());
    expect(await h.stores.switches.getCounter("upstream_unknown_network", today)).toBe(1);
    expect(await counter(h, "upstream_unknown_network")).toBe(1);
  });

  it("documents the rule and its effect next to the code and in the README", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const provider = readFileSync(new URL("./provider.ts", import.meta.url), "utf8");
    expect(readme).toContain("upstream_unknown_network");
    expect(readme).toMatch(/charged in full/);
    expect(provider).toMatch(/Workers `fetch` rejects with a generic `TypeError`/);
  });
});
