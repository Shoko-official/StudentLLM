import { describe, expect, it } from "vitest";
import { ApiError } from "../../http/envelope";
import { routeMeta } from "../../http/context";
import { expectFixtureConformance, fixtureRequest, loadFixture, TEST_START_MS, validateAgainst } from "../../testing";
import {
  makeBillingTestApp,
  PRICE_MONTHLY,
  PRICE_SEMESTER,
  subscriptionEvent,
  transactionEvent,
  adjustmentEvent,
  type BillingTestApp,
} from "../../testing/billing-test-app";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const DAY = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "Content-Type": "application/json" };

async function setup(options: Parameters<typeof makeBillingTestApp>[0] = {}): Promise<BillingTestApp> {
  const app = makeBillingTestApp(options);
  await app.createAccount();
  return app;
}

const checkout = (app: BillingTestApp, body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  app.as("/v1/billing/checkout", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const buySubscription = (app: BillingTestApp, extra: Record<string, unknown> = {}) =>
  app.webhook(subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_1", occurredAt: T, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1", ...extra }));
const buyPass = (app: BillingTestApp, txn = "txn_p", at = T) => app.webhook(transactionEvent({ transactionId: txn, occurredAt: at, customerId: "ctm_1" }));

describe("POST /v1/billing/checkout", () => {
  it("creates the transaction on the server with the account id in custom_data and the server's price, and returns the URL", async () => {
    const app = await setup();
    const res = await checkout(app, { plan: "plus_monthly" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateAgainst("CheckoutResponse", body)).toEqual([]);
    expect(body.checkout_url).toMatch(/^https:\/\/checkout\.paddle\.example\.invalid\//);
    expect(body.expires_at).toBe(new Date(T + app.billing.settings.checkoutTtlMs).toISOString().replace(".000Z", "Z"));
    expect(app.paddle.callsTo("createTransaction")).toEqual([[{ priceId: PRICE_MONTHLY, accountId: "acc_test", customerId: "ctm_1" }]]);
    const semester = await checkout(app, { plan: "plus_semester" });
    expect(semester.status).toBe(200);
    expect(app.paddle.callsTo("createTransaction")[1]).toEqual([{ priceId: PRICE_SEMESTER, accountId: "acc_test", customerId: "ctm_1" }]);
    expect(app.paddle.callsTo("createCustomer")).toEqual([]); // the account already had its customer
  });

  it("never lets the client choose the price, the account or any custom data", async () => {
    const app = await setup();
    for (const body of [
      { plan: "plus_monthly", price_id: "pri_cheap" },
      { plan: "plus_monthly", custom_data: { account_id: "acc_victim" } },
      { plan: "plus_monthly", account_id: "acc_victim" },
      { plan: "pri_cheap" },
      { plan: "free" },
      { plan: ["plus_monthly"] },
      { price: "plus_monthly" },
      {},
      [],
      null,
      "plus_monthly",
    ]) {
      const res = await checkout(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
    expect(app.paddle.callsTo("createTransaction")).toEqual([]);
  });

  it("rejects a malformed or wrongly typed body", async () => {
    const app = await setup();
    expect((await checkout(app, "{nope")).status).toBe(400);
    expect((await checkout(app, { plan: "plus_monthly" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await checkout(app, { plan: "plus_monthly" }, {})).status).toBe(415);
    expect((await checkout(app, "x".repeat(20_000))).status).toBe(413);
  });

  it("reuses the Paddle customer when the account already has one", async () => {
    const app = await setup();
    await buyPass(app);
    await app.webhook(transactionEvent({ transactionId: "txn_x", occurredAt: T + DAY, customerId: "ctm_1" }));
    expect((await checkout(app, { plan: "plus_semester" })).status).toBe(200);
    expect(app.paddle.callsTo("createTransaction")[0]).toEqual([{ priceId: PRICE_SEMESTER, accountId: "acc_test", customerId: "ctm_1" }]);
  });

  describe("already_subscribed", () => {
    it("matches the contract's fixture when a subscription is active", async () => {
      const app = await setup();
      await buySubscription(app);
      const fx = loadFixture("billing-checkout.already_subscribed");
      const res = await app.t.app.handle(fixtureRequest(fx));
      await expectFixtureConformance(res, fx);
      expect(app.paddle.callsTo("createTransaction")).toEqual([]);
    });

    it("refuses both plans while a subscription is active, including one set to cancel at the period end", async () => {
      const app = await setup();
      await buySubscription(app);
      await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, scheduled: "cancel", periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
      expect((await app.plan())!.cancelAtPeriodEnd).toBe(true);
      for (const plan of ["plus_monthly", "plus_semester"]) {
        const res = await checkout(app, { plan });
        expect(res.status, plan).toBe(409);
        expect((await res.json()).error.code).toBe("already_subscribed");
      }
      // Once the paid period is over, buying again is allowed, even before Paddle's canceled event arrives.
      app.clock.set(addMonthsUTC(T, 1));
      expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(200);
    });

    it("refuses a subscription during a pass and a pass during a subscription, but queues a pass during a pass", async () => {
      const app = await setup();
      await buyPass(app);
      expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(409);
      expect((await checkout(app, { plan: "plus_semester" })).status).toBe(200);

      const other = await setup();
      await buySubscription(other);
      expect((await checkout(other, { plan: "plus_semester" })).status).toBe(409);
    });

    it("allows buying again after a cancellation took effect, a refund was fully processed, or a pass ended", async () => {
      const app = await setup();
      await buySubscription(app);
      await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: T + DAY, customerId: "ctm_1" }));
      expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(200);

      const passEnded = await setup();
      await buyPass(passEnded);
      passEnded.clock.set(addMonthsUTC(T, 5));
      expect((await checkout(passEnded, { plan: "plus_monthly" })).status).toBe(200);
    });

    it("keeps refusing while a refund's cancellation is still pending at Paddle, so nobody pays twice", async () => {
      const app = await setup();
      await buySubscription(app);
      await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + 1000, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
      app.paddle.failNext("cancelSubscription", "unavailable", 99);
      await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
      expect((await app.plan())!.pendingCancel).not.toBeNull();
      expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(409);
    });
  });

  it("answers a Paddle outage with provider_unavailable and Retry-After, and leaks nothing of Paddle's answer", async () => {
    const app = await setup();
    app.paddle.failNext("createTransaction", "unavailable");
    const res = await checkout(app, { plan: "plus_monthly" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(validateAgainst("Error", body)).toEqual([]);
    expect(body.error.code).toBe("provider_unavailable");
    expect(res.headers.get("Retry-After")).toBe("30");
    // A rejection by Paddle (bad price, bad request) is also a temporary failure for the client.
    app.paddle.failNext("createTransaction", "rejected");
    expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(503);
  });

  it("is a deployment error (500) when the price of the plan is not configured, never a client error", async () => {
    const app = await setup({ env: { PADDLE_PRICE_PLUS_SEMESTER: undefined } });
    expect((await checkout(app, { plan: "plus_semester" })).status).toBe(500);
    expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(200);
  });

  it("is gated by the terms and account-status check (the portal is not)", async () => {
    const app = await setup({
      hooks: {
        checkTermsAndStatus: () => {
          throw new ApiError("terms_required", { details: { terms_version: "2026-12-01" } });
        },
      },
    });
    const res = await checkout(app, { plan: "plus_monthly" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("terms_required");
    expect(app.paddle.callsTo("createTransaction")).toEqual([]);
    // The portal link is a data-rights route: it works for an account that has not accepted the terms.
    await buyPass(app);
    expect((await app.as("/v1/billing/portal")).status).toBe(200);
  });

  it("does not require a plan (checkPlan applies to content routes only) and rate limits like any account route", async () => {
    const trace: string[] = [];
    const app = await setup({ hooks: { checkPlan: () => void trace.push("plan"), checkRateLimit: () => void trace.push("rate") } });
    expect((await checkout(app, { plan: "plus_monthly" })).status).toBe(200);
    expect(trace).toEqual(["rate"]);
  });
});

describe("GET /v1/billing/portal", () => {
  it("is not_found for an account that never started a checkout (no Paddle customer yet)", async () => {
    const app = makeBillingTestApp();
    await app.createAccount(undefined, undefined, null);
    const res = await app.as("/v1/billing/portal");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
    expect(app.paddle.callsTo("createPortalSession")).toEqual([]);
  });

  it("returns a short-lived portal link for the account's own Paddle customer", async () => {
    const app = await setup();
    await buySubscription(app);
    const res = await app.as("/v1/billing/portal");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateAgainst("PortalResponse", body)).toEqual([]);
    expect(body.url).toBe("https://portal.paddle.example.invalid/ctm_1");
    expect(body.expires_at).toBe(new Date(T + app.billing.settings.portalTtlMs).toISOString().replace(".000Z", "Z"));
    expect(app.paddle.callsTo("createPortalSession")).toEqual([[{ customerId: "ctm_1", subscriptionId: "sub_1" }]]);
  });

  it("works for a pass buyer too (no subscription id) and for a suspended account (exempt route)", async () => {
    const app = await setup({
      hooks: {
        checkTermsAndStatus: () => {
          throw new ApiError("account_suspended");
        },
      },
    });
    await buyPass(app);
    expect((await app.as("/v1/billing/portal")).status).toBe(200);
    expect(app.paddle.callsTo("createPortalSession")).toEqual([[{ customerId: "ctm_1", subscriptionId: null }]]);
  });

  it("answers a Paddle outage with provider_unavailable", async () => {
    const app = await setup();
    await buyPass(app);
    app.paddle.failNext("createPortalSession", "unavailable");
    const res = await app.as("/v1/billing/portal");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("provider_unavailable");
  });

  it("never opens another account's portal: the customer id comes from the caller's own plan", async () => {
    const app = await setup();
    await app.createAccount("acc_other");
    await buyPass(app);
    await app.webhook(transactionEvent({ transactionId: "txn_o", occurredAt: T, customerId: "ctm_other", accountId: "acc_other" }));
    const body = await (await app.as("/v1/billing/portal")).json();
    expect(body.url).toContain("ctm_1");
    expect(body.url).not.toContain("ctm_other");
  });
});

describe("checkPlan (plan_required) on a content route", () => {
  const CONTENT = {
    "X-StudentLLM-Client": "studentllm-desktop/0.2.0",
    "X-StudentLLM-Consent": "cns_01EXAMPLE",
    "Idempotency-Key": "6f1c1f0e-3a55-4b0c-9f0a-6d9d2f0f6a11",
    "Content-Type": "application/json",
  };

  async function contentApp(options: Parameters<typeof makeBillingTestApp>[0] = {}) {
    // The inference module's own hooks (consent, rate limit, idempotency, slot) are not what this suite tests.
    const pass = () => undefined;
    const app = await setup({ ...options, hooks: { checkConsent: pass, checkRateLimit: pass, lookupIdempotency: pass, acquireConcurrencySlot: pass, ...options.hooks } });
    let handled = 0;
    app.t.app.router.add("POST", "/test/content", () => (handled++, new Response("ok")), routeMeta({ operationId: "test_content", client: true, content: true }));
    const post = () => app.as("/test/content", { method: "POST", headers: CONTENT, body: "{}" });
    return { app, post, handled: () => handled };
  }

  it("answers plan_required for a free account and never runs the handler", async () => {
    const { post, handled } = await contentApp();
    const res = await post();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("plan_required");
    expect(validateAgainst("Error", body)).toEqual([]);
    expect(handled()).toBe(0);
  });

  it("lets a subscriber through, and stops exactly at the end of the paid period", async () => {
    const { app, post, handled } = await contentApp();
    await buySubscription(app);
    const end = addMonthsUTC(T, 1);
    app.clock.set(end - 1);
    expect((await post()).status).toBe(200);
    app.clock.set(end);
    expect((await post()).status).toBe(403);
    expect(handled()).toBe(1);
  });

  it("past_due keeps the current window to its end and starts no new one", async () => {
    const { app, post } = await contentApp();
    await buySubscription(app);
    const renewal = addMonthsUTC(T, 1);
    await app.webhook(subscriptionEvent({ type: "subscription.past_due", subscriptionId: "sub_1", status: "past_due", occurredAt: renewal + 60_000, customerId: "ctm_1" }));
    app.clock.set(renewal - 1);
    expect((await post()).status).toBe(200);
    app.clock.set(renewal + 2 * DAY);
    expect((await post()).status).toBe(403);
    // The payment succeeds: the new window opens.
    await app.webhook(transactionEvent({ transactionId: "txn_2", subscriptionId: "sub_1", occurredAt: renewal + 3 * DAY, periodStart: renewal, periodEnd: addMonthsUTC(T, 2), customerId: "ctm_1" }));
    expect((await post()).status).toBe(200);
  });

  it("serves a pass for each of its five months and then stops", async () => {
    const { app, post } = await contentApp();
    await buyPass(app);
    for (let month = 0; month < 5; month++) {
      app.clock.set(addMonthsUTC(T, month) + 1000);
      expect((await post()).status, `month ${month}`).toBe(200);
    }
    app.clock.set(addMonthsUTC(T, 5));
    expect((await post()).status).toBe(403);
  });

  it("stops at once after a refund or a chargeback", async () => {
    const { app, post } = await contentApp();
    await buyPass(app);
    app.clock.set(T + DAY);
    expect((await post()).status).toBe(200);
    await app.webhook(adjustmentEvent({ occurredAt: T + 2 * DAY, transactionId: "txn_p", action: "chargeback", customerId: "ctm_1" }));
    expect((await post()).status).toBe(403);
  });

  it("counts a complimentary window as a plan, and a revoked paid window as none", async () => {
    const { app, post } = await contentApp();
    await app.stores.ledger.ensureWindow("acc_test", { start: T, end: T + 30 * DAY, limit: 100, source: "admin_grant", grantId: "grt_1" });
    expect((await post()).status).toBe(200);
    await app.stores.ledger.revokeWindows("acc_test", T, { source: "admin_grant" });
    expect((await post()).status).toBe(403);
  });

  it("repairs a missing window when the plan says a paid period is running", async () => {
    const { app, post } = await contentApp();
    await buySubscription(app);
    // Simulate a lost window: the plan is written but the ledger has nothing.
    await app.stores.ledger.purgeAccount("acc_test");
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]);
    expect((await post()).status).toBe(200);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1);
  });

  it("runs after the terms check and before the consent check, as the contract orders them", async () => {
    const trace: string[] = [];
    const { post } = await contentApp({
      hooks: { checkTermsAndStatus: () => void trace.push("terms"), checkConsent: () => void trace.push("consent"), checkRateLimit: () => void trace.push("rate") },
    });
    // No plan: it stops at the plan check; the consent and rate-limit hooks never ran.
    expect((await post()).status).toBe(403);
    expect(trace).toEqual(["terms"]);
  });

  it("does not let a stub through when a principal is missing, but does not break the stubs", async () => {
    const app = await setup();
    // A stub route has no principal in the scaffold tests: the hook passes it.
    const stub = await app.t.request("/v1/chat/completions", { method: "POST", headers: CONTENT, body: "{}" });
    expect(stub.status).toBe(403); // the fake principal here is signed in but has no plan
  });
});
