import { describe, expect, it } from "vitest";
import { expectFixtureConformance, loadFixture } from "../../testing";
import { makeInferenceHarness, routingWithMedia, type Harness } from "../../testing/inference-harness";

/** GET /v1/status is public: no token, only the client header. */
const status = (h: Harness, headers: Record<string, string> = { "X-StudentLLM-Client": "studentllm-desktop/0.2.0" }) =>
  h.t.app.handle(new Request("https://api.example.invalid/v1/status", { headers }));

describe("GET /v1/status", () => {
  it("answers ok with the minimum client version, what each feature can do and the server time", async () => {
    const h = makeInferenceHarness();
    const res = await status(h);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-StudentLLM-Min-Client")).toBe("0.2.0");
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.min_client_version).toBe("0.2.0");
    expect(json.server_time).toBe("2026-11-01T09:30:00Z");
    // The default table has a chat model and no transcription or OCR model: the app falls back to local for those.
    expect(json.features).toEqual({ chat: true, transcription: false, ocr: false });
  });

  it("conforms to the fixture when every feature is configured", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia() });
    await expectFixtureConformance(await status(h), loadFixture("status.get.success"));
  });

  it("answers client_outdated below the minimum, and invalid_request without the header", async () => {
    const h = makeInferenceHarness();
    const outdated = await status(h, { "X-StudentLLM-Client": "studentllm-desktop/0.1.0" });
    await expectFixtureConformance(outdated, loadFixture("status.client_outdated"), { strictHeaders: ["X-StudentLLM-Min-Client"] });
    const missing = await status(h, {});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("invalid_request");
  });

  it("needs no token", async () => {
    const h = makeInferenceHarness({ plus: false });
    const res = await status(h);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-StudentLLM-Plan-Version")).toBeNull(); // there is no account behind it
  });

  it("is degraded under a provider or feature switch and says which feature went down", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia() });
    await h.stores.switches.setDisabled({ scope: "feature", name: "ocr" }, true, h.clock.now());
    const json = await (await status(h)).json();
    expect(json.status).toBe("degraded");
    expect(json.features).toEqual({ chat: true, transcription: true, ocr: false });

    await h.stores.switches.setDisabled({ scope: "provider", name: "groq" }, true, h.clock.now());
    expect((await (await status(h)).json()).features).toEqual({ chat: false, transcription: false, ocr: false });
  });

  it("is in maintenance under the global kill switch", async () => {
    const h = makeInferenceHarness();
    await h.stores.switches.setDisabled({ scope: "global" }, true, h.clock.now());
    const json = await (await status(h)).json();
    expect(json.status).toBe("maintenance");
    expect(json.features.chat).toBe(false);
  });

  it("is degraded and has no features once the global spend cap is reached", async () => {
    const h = makeInferenceHarness({ settings: { spendCap: { dayCredits: 10, monthCredits: 100 } } });
    await h.stores.switches.addSpend(`day:${new Date(h.clock.now()).toISOString().slice(0, 10)}`, 10);
    const json = await (await status(h)).json();
    expect(json.status).toBe("degraded");
    expect(json.features.chat).toBe(false);
  });

  it("is degraded when a configured model is switched off in the table", async () => {
    const routing = routingWithMedia();
    const h = makeInferenceHarness({ routing: { ...routing, models: routing.models.map((m) => (m.feature === "ocr" ? { ...m, enabled: false } : m)) } });
    const json = await (await status(h)).json();
    expect(json.features).toEqual({ chat: true, transcription: true, ocr: false });
    expect(json.status).toBe("degraded");
  });
});
