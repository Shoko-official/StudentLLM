// The inference module together with the others: the full app (auth, account, billing, inference, ops) starts with its
// fail-closed hook check and no opt-out, the account routes keep their own rate-limit window, the budget of a window is
// the billing module's, and the provider sets, the models and the consent check agree.

import { describe, expect, it } from "vitest";
import worker from "../../index";
import { HOOK_ORDER, isMissingHook, mergeProvidedHooks } from "../../http/pipeline";
import { expectFixtureConformance, fakeExecutionContext, loadFixture, makeTestApp, testEnv, TEST_START_MS } from "../../testing";
import { makeBillingTestApp, subscriptionEvent, transactionEvent } from "../../testing/billing-test-app";
import { ACCOUNT_ID, completion, dumpStores, makeInferenceHarness, SECRET_PROMPT } from "../../testing/inference-harness";
import { createAccountHooks } from "../account";
import { createAuthHooks } from "../auth";
import { createBillingHooks } from "../billing";
import { addMonthsUTC } from "../billing/windows";
import { createInferenceHooks } from ".";
import { providerSetViews } from "./catalog";
import { DEFAULT_ROUTING } from "./routing";

const T = TEST_START_MS;
const body = { model: "studentllm-large", messages: [{ role: "user", content: `Question ${SECRET_PROMPT}` }] };

describe("the full app starts with the fail-closed hook check and no opt-out", () => {
  it("builds with all five modules and no allowMissingHooks", () => {
    // `createApp` throws "pipeline hooks are missing" when a registered real handler lacks a hook.
    expect(() => makeTestApp()).not.toThrow();
  });

  it("has every one of the eight hooks provided by exactly one module", () => {
    const t = makeTestApp();
    const merged = mergeProvidedHooks(createAuthHooks(t.deps), createAccountHooks(t.deps), createBillingHooks(t.deps), createInferenceHooks(t.deps));
    expect(Object.keys(merged).sort()).toEqual([...HOOK_ORDER].sort());
    for (const name of HOOK_ORDER) expect(isMissingHook(merged[name]!), name).toBe(false);
    // The inference module is the owner of exactly these four.
    expect(Object.keys(createInferenceHooks(t.deps)).sort()).toEqual(["acquireConcurrencySlot", "checkConsent", "checkRateLimit", "lookupIdempotency"]);
  });

  it("serves through the Worker entry (its startup check passes for the app built with every module)", async () => {
    const res = await worker.fetch(
      new Request("https://api.example.invalid/v1/status", { headers: { "X-StudentLLM-Client": "studentllm-desktop/0.2.0" } }),
      testEnv(),
      fakeExecutionContext(),
    );
    // A failed startup answers every request with a 500 internal_error; a built app answers the status route.
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("no route of any module is left as the 501 stub, except the ones nobody owns yet", () => {
    const stubs = makeTestApp().app.router.routes().filter((r) => r.isStub).map((r) => r.meta.operationId);
    expect(stubs).toEqual([]);
  });
});

describe("the account routes keep their own rate-limit window", () => {
  const settings = { rate: { content: { limit: 1, windowMs: 60_000 } } };

  it("an exhausted chat window does not throttle the account routes", async () => {
    const h = makeInferenceHarness({ settings, upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    expect((await h.chat(body)).status).toBe(200);
    expect((await h.chat(body)).status).toBe(429); // the content window is spent
    for (const path of ["/v1/account", "/v1/devices", "/v1/provider-sets"]) {
      const res = await h.get(path);
      expect(res.status, path).toBe(200);
      // The headers are those of the account window (60 a minute), not the chat window's (1).
      expect(res.headers.get("RateLimit-Limit"), path).toBe("60");
    }
  });

  it("the account routes spend only `acct:<id>:account-api`, and chat only `acct:<id>:content`", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    await h.get("/v1/account");
    await h.get("/v1/devices");
    const afterAccount = dumpStores(h.stores);
    expect(afterAccount).toContain(`acct:${ACCOUNT_ID}:account-api`);
    expect(afterAccount).not.toContain(`acct:${ACCOUNT_ID}:content`);
    expect(afterAccount).not.toContain(`acct:${ACCOUNT_ID}:read`);
    const chat = await h.chat(body);
    expect(chat.headers.get("RateLimit-Limit")).toBe("20");
    expect(chat.headers.get("RateLimit-Remaining")).toBe("19"); // the two account requests did not take a hit from it
    expect(dumpStores(h.stores)).toContain(`acct:${ACCOUNT_ID}:content`);
  });

  it("an exhausted account window does not throttle chat", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await h.get("/v1/account")).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    expect((await h.chat(body)).status).toBe(200);
  });

  it("only a route of this module is ever given the chat window", () => {
    const h = makeInferenceHarness();
    for (const route of h.t.app.router.routes()) {
      if (route.meta.rateLimit !== "account") continue;
      // A route that declares the per-account hook gets the `content` bucket only when it is a content route.
      expect(route.meta.content, `${route.method} ${route.pattern}`).toBe(["chatCompletions", "transcribeAudio", "ocrImage"].includes(route.meta.operationId));
    }
  });
});

describe("the budget of a window is the billing module's", () => {
  it("creates a lazy window with the billing limit, and a different limit when billing's settings differ", async () => {
    const h = makeInferenceHarness({ windowCredits: 777, upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    await h.chat(body);
    expect((await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now()))!.limit).toBe(777);
    expect(h.t.deps.billing.settings.windowCredits.plus_monthly).toBe(777);
    // The default is the billing module's, not a constant of this module.
    const d = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    await d.chat(body);
    expect((await d.stores.ledger.getCurrentWindow(ACCOUNT_ID, d.clock.now()))!.limit).toBe(d.t.deps.billing.settings.windowCredits.plus_monthly);
  });

  it("a lazy window is the same window the webhook creates for a monthly subscription", async () => {
    const billing = makeBillingTestApp();
    await billing.createAccount();
    await billing.webhook(subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_1", occurredAt: T, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    const made = await billing.stores.ledger.listWindows(ACCOUNT_ID);
    expect(made).toHaveLength(1);

    // The same plan, with no window yet: the inference module creates one lazily.
    const h = makeInferenceHarness({ plan: (await billing.plan())! });
    await h.get("/v1/usage");
    const lazy = await h.stores.ledger.listWindows(ACCOUNT_ID);
    expect(lazy.map((w) => [w.start, w.end, w.limit])).toEqual(made.map((w) => [w.start, w.end, w.limit]));
    // ... and a request spends from it.
    expect((await h.chat(body)).status).toBe(200);
    expect(await h.stores.ledger.listWindows(ACCOUNT_ID)).toHaveLength(1);
  });

  it("agrees for each of the five months of a semester pass", async () => {
    const billing = makeBillingTestApp();
    await billing.createAccount();
    await billing.webhook(transactionEvent({ transactionId: "txn_pass", occurredAt: T, customerId: "ctm_1" }));
    const made = (await billing.stores.ledger.listWindows(ACCOUNT_ID)).sort((a, b) => a.start - b.start);
    expect(made).toHaveLength(5);

    for (const window of made) {
      const h = makeInferenceHarness({ plan: (await billing.plan())! });
      h.clock.set(window.start + 3_600_000); // an hour into that month
      const usage = await (await h.get("/v1/usage")).json();
      const lazy = (await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now()))!;
      expect([lazy.start, lazy.end, lazy.limit]).toEqual([window.start, window.end, window.limit]);
      expect(usage.credits.limit).toBe(window.limit);
    }
  });

  it("agrees with a window billing created even when the settings differ from the default", async () => {
    const billing = makeBillingTestApp({ overrides: { settings: { windowCredits: { plus_monthly: 4321, plus_semester: 4321 } } } });
    await billing.createAccount();
    await billing.webhook(subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_1", occurredAt: T, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    const made = (await billing.stores.ledger.listWindows(ACCOUNT_ID))[0]!;
    const h = makeInferenceHarness({ plan: (await billing.plan())!, windowCredits: 4321 });
    await h.get("/v1/usage");
    expect((await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now()))!.limit).toBe(made.limit);
  });
});

describe("/v1/provider-sets, /v1/models and the consent check agree", () => {
  it("serves the sets of the routing table, with the fixture's shape", async () => {
    const h = makeInferenceHarness();
    const res = await h.get("/v1/provider-sets");
    await expectFixtureConformance(res.clone(), loadFixture("provider-sets.list.success"));
    const sets = (await res.json()).provider_sets;
    const views = providerSetViews(h.t.deps.inference.routing);
    expect(sets).toEqual(
      views.map((v) => ({ id: v.id, version: v.version, providers: v.providers, regions: v.regions, consent_text_version: v.consentTextVersion, features: v.features })),
    );
    expect(sets[0].providers).toEqual(["Groq"]);
  });

  it("a record made through POST /v1/consent with the endpoints' versions is accepted by the chat route", async () => {
    const h = makeInferenceHarness({ consent: false, upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    const set = (await (await h.get("/v1/provider-sets")).json()).provider_sets[0];
    const model = (await (await h.get("/v1/models")).json()).data[0];
    expect(model.provider_set).toBe(set.id);
    expect(model.provider_set_version).toBe(set.version);

    const grant = (overrides: Record<string, unknown> = {}) =>
      h.t.app.handle(
        new Request("https://api.example.invalid/v1/consent", {
          method: "POST",
          headers: { ...h.headers({ "Idempotency-Key": null, "X-StudentLLM-Consent": null }), "Content-Type": "application/json" },
          body: JSON.stringify({ provider_set: set.id, provider_set_version: set.version, features: ["chat"], text_version: set.consent_text_version, granted: true, ...overrides }),
        }),
        h.executionCtx,
      );
    // A stale version or text version cannot collect consent ...
    expect((await grant({ provider_set_version: set.version + 1 })).status).toBe(409);
    expect((await grant({ text_version: "2020-01-01" })).status).toBe(409);
    // ... the current ones can, and the id it returns is the one the chat route accepts.
    const ok = await grant();
    expect(ok.status).toBe(200);
    const record = await ok.json();
    expect((await h.chat(body, { "X-StudentLLM-Consent": record.consent_id })).status).toBe(200);
    // Withdrawn, the same id is outdated.
    await grant({ granted: false });
    expect((await h.chat(body, { "X-StudentLLM-Consent": record.consent_id })).status).toBe(409);
  });

  it("all three move together when the routing table changes", async () => {
    const bumped = { ...DEFAULT_ROUTING, providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, version: 3, consentTextVersion: "2027-02-02" }] };
    const h = makeInferenceHarness({ routing: bumped, consent: false, upstream: () => completion("ok", { prompt: 5, completion: 5 }) });
    const set = (await (await h.get("/v1/provider-sets")).json()).provider_sets[0];
    const model = (await (await h.get("/v1/models")).json()).data[0];
    expect([set.version, set.consent_text_version, model.provider_set_version]).toEqual([3, "2027-02-02", 3]);
    // An old build with the old text cannot consent; one with the new text can and then chats.
    const grant = (version: number, text: string) =>
      h.t.app.handle(
        new Request("https://api.example.invalid/v1/consent", {
          method: "POST",
          headers: { ...h.headers({ "Idempotency-Key": null, "X-StudentLLM-Consent": null }), "Content-Type": "application/json" },
          body: JSON.stringify({ provider_set: "ps1", provider_set_version: version, features: ["chat"], text_version: text, granted: true }),
        }),
        h.executionCtx,
      );
    expect((await grant(1, "2026-11-01")).status).toBe(409);
    const ok = await grant(3, "2027-02-02");
    expect(ok.status).toBe(200);
    expect((await h.chat(body, { "X-StudentLLM-Consent": (await ok.json()).consent_id })).status).toBe(200);
  });
});
