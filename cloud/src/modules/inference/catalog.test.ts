import { describe, expect, it } from "vitest";
import { expectFixtureConformance, loadFixture, validateAgainst } from "../../testing";
import { ACCOUNT_ID, completion, makeInferenceHarness, routingWithMedia, SECRET_PROMPT } from "../../testing/inference-harness";

const body = { model: "studentllm-large", messages: [{ role: "user", content: `Question ${SECRET_PROMPT}` }] };

describe("GET /v1/models", () => {
  it("lists the logical models of the routing table and conforms to the fixture", async () => {
    const h = makeInferenceHarness();
    const res = await h.get("/v1/models");
    await expectFixtureConformance(res.clone(), loadFixture("models.list.success"));
    const json = await res.json();
    expect(json.data).toEqual([
      {
        id: "studentllm-large",
        object: "model",
        features: ["chat"],
        context_window: 131072,
        max_output_tokens: 4096,
        credits_per_1k_input: 1.62,
        credits_per_1k_output: 6.48,
        provider_set: "ps1",
        provider_set_version: 1,
        requires_plan: "plus",
        available: true,
      },
    ]);
    // Never the upstream model id, the provider's host or a key.
    const text = JSON.stringify(json);
    expect(text).not.toContain("gpt-oss");
    expect(text).not.toContain("groq");
  });

  it("works for a free account (the app compares provider_set with its consent)", async () => {
    const h = makeInferenceHarness({ plus: false });
    expect((await h.get("/v1/models")).status).toBe(200);
  });

  it("lists audio and image models with the integers the schema requires", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia() });
    const json = await (await h.get("/v1/models")).json();
    expect(validateAgainst("ModelList", json)).toEqual([]);
    expect(json.data.map((m: { id: string; features: string[] }) => [m.id, m.features[0]])).toEqual([
      ["studentllm-large", "chat"],
      ["studentllm-transcribe", "transcription"],
      ["studentllm-ocr", "ocr"],
    ]);
  });

  it("reports a model as unavailable under a kill switch or the spend cap", async () => {
    const h = makeInferenceHarness();
    await h.stores.switches.setDisabled({ scope: "provider", name: "groq" }, true, h.clock.now());
    expect((await (await h.get("/v1/models")).json()).data[0].available).toBe(false);
    await h.stores.switches.setDisabled({ scope: "provider", name: "groq" }, false, h.clock.now());
    expect((await (await h.get("/v1/models")).json()).data[0].available).toBe(true);
    const capped = makeInferenceHarness({ settings: { spendCap: { dayCredits: 1, monthCredits: 10 } } });
    await capped.stores.switches.addSpend(`day:${new Date(capped.clock.now()).toISOString().slice(0, 10)}`, 1);
    expect((await (await capped.get("/v1/models")).json()).data[0].available).toBe(false);
  });
});

describe("GET /v1/provider-sets", () => {
  it("lists the sets with provider names, regions and the consent text version", async () => {
    const h = makeInferenceHarness();
    const res = await h.get("/v1/provider-sets");
    await expectFixtureConformance(res.clone(), loadFixture("provider-sets.list.success"));
    const json = await res.json();
    expect(json.provider_sets).toHaveLength(1);
    expect(json.provider_sets[0]).toMatchObject({ id: "ps1", version: 1, providers: ["Groq"], consent_text_version: "2026-11-01", features: ["chat"] });
    // The region is a placeholder until it is verified with the provider.
    expect(json.provider_sets[0].regions[0]).toContain("PLACEHOLDER");
  });
});

describe("GET /v1/usage", () => {
  it("gives a free account a valid empty answer", async () => {
    const h = makeInferenceHarness({ plus: false });
    const res = await h.get("/v1/usage");
    await expectFixtureConformance(res.clone(), loadFixture("usage.get.free_account"));
    expect(await res.json()).toEqual({
      window: null,
      credits: { limit: 0, used: 0, reserved: 0, remaining: 0, resets_at: null },
      by_feature: { chat: 0, transcription: 0, ocr: 0 },
      requests: 0,
    });
  });

  it("shows the window a paid account would get before its first request", async () => {
    const h = makeInferenceHarness();
    const res = await h.get("/v1/usage");
    const json = await res.json();
    expect(validateAgainst("Usage", json)).toEqual([]);
    expect(json.window).toEqual({ start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" });
    expect(json.credits).toEqual({ limit: 15000, used: 0, reserved: 0, remaining: 15000, resets_at: "2026-12-01T00:00:00Z" });
    expect(res.headers.get("X-StudentLLM-Credits-Remaining")).toBe("15000");
    expect(res.headers.get("X-StudentLLM-Credits-Limit")).toBe("15000");
    expect(res.headers.get("X-StudentLLM-Credits-Reset")).toBe("2026-12-01T00:00:00Z");
  });

  it("reports what was used per feature and conforms to the fixture", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 900, completion: 120 }) });
    await h.chat(body);
    await h.chat(body);
    const res = await h.get("/v1/usage");
    await expectFixtureConformance(res.clone(), loadFixture("usage.get.success"));
    const json = await res.json();
    expect(json.credits).toMatchObject({ used: 6, reserved: 0, remaining: 14994 });
    expect(json.by_feature).toEqual({ chat: 6, transcription: 0, ocr: 0 });
    expect(json.requests).toBe(2);
  });

  it("counts a reservation that is still held", async () => {
    let release!: () => void;
    const h = makeInferenceHarness({ upstream: () => new Promise((resolve) => (release = () => resolve(completion("ok", { prompt: 1, completion: 1 })))) });
    const pending = h.chat(body);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const json = await (await h.get("/v1/usage")).json();
    expect(json.credits.reserved).toBeGreaterThan(20);
    expect(json.credits.remaining).toBe(15000 - json.credits.reserved);
    release();
    await pending;
  });

  it("is per account", async () => {
    const h = makeInferenceHarness();
    await h.chat(body);
    expect((await h.stores.ledger.getCurrentWindow("acc_other", h.clock.now()))).toBeNull();
    expect(ACCOUNT_ID).toBe("acc_test");
  });
});
