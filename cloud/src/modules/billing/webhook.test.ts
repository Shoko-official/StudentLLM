import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "../../storage";
import { chaosStores } from "../../testing/store-contract";
import {
  adjustmentEvent,
  makeBillingTestApp,
  paddleSignature,
  PRICE_MONTHLY,
  PRICE_SEMESTER,
  subscriptionEvent,
  transactionEvent,
  WEBHOOK_SECRET,
  WEBHOOK_SECRET_PREVIOUS,
  type BillingTestApp,
} from "../../testing/billing-test-app";
import { checkFixtureConformance, expectFixtureConformance, fixtureRequest, loadFixture, TEST_START_MS } from "../../testing";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS; // 2026-11-01T09:30:00Z
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function body(res: Response): Promise<any> {
  return res.json();
}

async function setup(options: Parameters<typeof makeBillingTestApp>[0] = {}): Promise<BillingTestApp> {
  const app = makeBillingTestApp(options);
  await app.createAccount();
  return app;
}

const firstSubscription = (at = T, extra: Record<string, unknown> = {}) =>
  subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_1", occurredAt: at, periodStart: at, periodEnd: addMonthsUTC(at, 1), customerId: "ctm_1", ...extra });

describe("webhook: signature", () => {
  it("accepts a correctly signed event and returns the contract's empty 200", async () => {
    const app = await setup();
    const res = await app.webhook(firstSubscription());
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({});
  });

  it("conforms to the contract's fixture", async () => {
    const fx = loadFixture("webhook-paddle.success");
    const app = await setup();
    // The fixture's signature is a placeholder; sign the fixture's own body for real.
    const raw = JSON.stringify(fx.request.body);
    const headers = { ...fx.request.headers, "Paddle-Signature": await paddleSignature(WEBHOOK_SECRET, raw, app.clock.now()) };
    const req = fixtureRequest({ ...fx, request: { ...fx.request, headers } });
    const res = await app.t.app.handle(req);
    await expectFixtureConformance(res, fx);
    // The fixture carries no custom_data and its ids are unknown, so it is accepted (200) and quarantined.
    expect(await app.stores.webhookEvents.get("evt_01EXAMPLE")).toMatchObject({ state: "quarantined", fields: { subscription_id: "sub_01EXAMPLE", status: "active" } });
  });

  it("rejects a bad signature with 401 and no detail, before anything is parsed or stored", async () => {
    const app = await setup();
    const ev = firstSubscription();
    const good = await paddleSignature(WEBHOOK_SECRET, JSON.stringify(ev), T);
    const forged = good.replace(/h1=[0-9a-f]/, (m) => `${m.slice(0, 3)}${m[3] === "0" ? "1" : "0"}`);
    for (const header of [forged, await paddleSignature("some-other-secret-0123456789abcdef0123456789", JSON.stringify(ev), T), "h1=deadbeef", "ts=abc;h1=" + "0".repeat(64), "", null]) {
      const res = await app.webhook(ev, { header });
      expect(res.status, String(header)).toBe(401);
      const b = await body(res);
      expect(b.error.code).toBe("invalid_token");
      expect(JSON.stringify(b)).not.toMatch(/sub_1|hmac|secret/i);
      expect(await checkFixtureConformance(new Response(JSON.stringify(b), { status: 401 }), { ...loadFixture("webhook-paddle.success"), response: { status: 401, headers: {} }, response_schema: "Error" })).toEqual([]);
    }
    expect(await app.stores.webhookEvents.get((ev as any).event_id)).toBeNull();
    expect(await app.plan()).toBeNull();
  });

  it("verifies the RAW bytes: a body changed after signing is rejected, even when it parses to the same event", async () => {
    const app = await setup();
    const ev = firstSubscription();
    const raw = JSON.stringify(ev);
    const header = await paddleSignature(WEBHOOK_SECRET, raw, T);
    // Same JSON value, different bytes (whitespace): the signature does not cover them.
    const res = await app.webhook(ev, { header, rawBody: JSON.stringify(ev, null, 2) });
    expect(res.status).toBe(401);
    expect(await app.plan()).toBeNull();
    // The exact signed bytes pass, whatever their formatting.
    const pretty = JSON.stringify(ev, null, 2);
    expect((await app.webhook(ev, { rawBody: pretty })).status).toBe(200);
  });

  it("rejects a timestamp outside the tolerance, in both directions, and accepts one at its edge", async () => {
    const app = await setup();
    const tolerance = app.billing.settings.signatureToleranceMs;
    for (const skew of [-(tolerance + 1000), tolerance + 1000, -3600_000, 3600_000]) {
      const res = await app.webhook(firstSubscription(), { at: T + skew });
      expect(res.status, String(skew)).toBe(401);
    }
    expect(await app.plan()).toBeNull();
    expect((await app.webhook(firstSubscription(), { at: T - tolerance + 1000 })).status).toBe(200);
  });

  it("does not let a captured request be replayed later with the same signature", async () => {
    const app = await setup();
    const ev = firstSubscription();
    const raw = JSON.stringify(ev);
    const header = await paddleSignature(WEBHOOK_SECRET, raw, T);
    expect((await app.webhook(ev, { header, rawBody: raw })).status).toBe(200);
    app.clock.advance(app.billing.settings.signatureToleranceMs + 5000);
    expect((await app.webhook(ev, { header, rawBody: raw })).status).toBe(401);
  });

  it("accepts the current and the previous secret during a rotation, and a header carrying both", async () => {
    const app = await setup();
    const a = firstSubscription(T, { eventId: "evt_cur" });
    expect((await app.webhook(a, { signWith: WEBHOOK_SECRET })).status).toBe(200);
    const b = subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 1000, eventId: "evt_prev", customerId: "ctm_1" });
    expect((await app.webhook(b, { signWith: WEBHOOK_SECRET_PREVIOUS })).status).toBe(200);
    const c = subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 2000, eventId: "evt_both", customerId: "ctm_1" });
    expect((await app.webhook(c, { signWith: ["a".repeat(40) + "unrelated", WEBHOOK_SECRET_PREVIOUS] })).status).toBe(200);
  });

  it("stops accepting the previous secret once the rotation is over (it is no longer configured)", async () => {
    const app = await setup({ env: { PADDLE_WEBHOOK_SECRET_PREVIOUS: undefined } });
    expect((await app.webhook(firstSubscription(), { signWith: WEBHOOK_SECRET_PREVIOUS })).status).toBe(401);
    expect((await app.webhook(firstSubscription(), { signWith: WEBHOOK_SECRET })).status).toBe(200);
  });

  it("keeps sandbox and live strictly apart: a sandbox secret is rejected by a live endpoint", async () => {
    const SANDBOX = "whsec_sandbox_0123456789abcdef0123456789abcdef";
    const LIVE = "whsec_live_0123456789abcdef0123456789abcdef0123";
    const live = await setup({ env: { PADDLE_ENVIRONMENT: "live", PADDLE_WEBHOOK_SECRET: LIVE, PADDLE_WEBHOOK_SECRET_PREVIOUS: undefined } });
    expect((await live.webhook(firstSubscription(), { signWith: SANDBOX })).status).toBe(401);
    expect(await live.plan()).toBeNull();
    expect((await live.webhook(firstSubscription(), { signWith: LIVE })).status).toBe(200);
    // And the other way round.
    const sandbox = await setup({ env: { PADDLE_ENVIRONMENT: "sandbox", PADDLE_WEBHOOK_SECRET: SANDBOX, PADDLE_WEBHOOK_SECRET_PREVIOUS: undefined } });
    expect((await sandbox.webhook(firstSubscription(), { signWith: LIVE })).status).toBe(401);
  });

  it("refuses a body that is too large before it is buffered, with the contract's payload_too_large", async () => {
    const app = await setup();
    const big = JSON.stringify({ ...firstSubscription(), padding: "x".repeat(300 * 1024) });
    const res = await app.webhook(null, { rawBody: big, header: null });
    // Header missing: rejected without reading. With a header, the size cap answers 413.
    expect(res.status).toBe(401);
    const signed = await app.webhook(null, { rawBody: big, header: await paddleSignature(WEBHOOK_SECRET, big, T) });
    expect(signed.status).toBe(413);
    expect((await body(signed)).error.code).toBe("payload_too_large");
    expect(await app.plan()).toBeNull();
  });

  it("answers a signed body that is not JSON, not UTF-8, or not an event with 400/415 and stores nothing", async () => {
    const app = await setup();
    const sign = (raw: string | Uint8Array) => paddleSignature(WEBHOOK_SECRET, raw, T);
    const cases: Array<[string | Uint8Array, number, string]> = [
      ["{not json", 400, "invalid_request"],
      [new Uint8Array([0xff, 0xfe, 0xfd]), 400, "invalid_request"],
      ["[]", 400, "invalid_request"],
      ["null", 400, "invalid_request"],
      [JSON.stringify({ event_type: "subscription.updated", occurred_at: "2026-11-01T09:30:00Z" }), 400, "invalid_request"],
      [JSON.stringify({ event_id: "evt_1", event_type: "subscription.updated", occurred_at: "yesterday" }), 400, "invalid_request"],
      [JSON.stringify({ event_id: "evt 1", event_type: "subscription.updated", occurred_at: "2026-11-01T09:30:00Z" }), 400, "invalid_request"],
      [JSON.stringify({ event_id: "evt_1", event_type: "Subscription Updated!", occurred_at: "2026-11-01T09:30:00Z" }), 400, "invalid_request"],
    ];
    for (const [raw, status, code] of cases) {
      const res = await app.webhook(null, { rawBody: raw, header: await sign(raw) });
      expect(res.status, String(raw)).toBe(status);
      expect((await body(res)).error.code).toBe(code);
    }
    const wrongType = await app.webhook(null, { rawBody: "{}", header: await sign("{}"), headers: { "Content-Type": "text/plain" } });
    expect(wrongType.status).toBe(415);
    expect(await app.stores.webhookEvents.listQuarantined()).toEqual([]);
  });
});

describe("webhook: claim, replay and parallel delivery", () => {
  it("answers a replayed event id with 2xx and no second effect", async () => {
    const app = await setup();
    const ev = firstSubscription();
    expect((await app.webhook(ev)).status).toBe(200);
    const version = (await app.stores.accounts.getById("acc_test"))!.planVersion;
    const windows = await app.stores.ledger.listWindows("acc_test");
    // Even a replay with a different body under the same id changes nothing: the claim is the id.
    const tampered = { ...(ev as any), data: { ...(ev as any).data, status: "canceled" } };
    expect((await app.webhook(tampered)).status).toBe(200);
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(version);
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual(windows);
    expect((await app.plan())!.status).toBe("active");
  });

  it("processes one of several parallel deliveries of the same event, under reordering storage", async () => {
    const app = await setup({ stores: chaosStores(createInMemoryStores(), 99) });
    const ev = firstSubscription();
    const results = await Promise.all(Array.from({ length: 8 }, () => app.webhook(ev)));
    for (const r of results) expect([200, 503]).toContain(r.status);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    // The losers that saw the claim in progress were told to retry (not to give up).
    for (const r of results.filter((x) => x.status === 503)) expect((await body(r)).error.retry_after_seconds).toBeGreaterThan(0);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1);
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(1);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))).toMatchObject({ state: "processed", attempt: 1 });
    // Paddle's retry of a 503 then finds a finished event.
    expect((await app.webhook(ev)).status).toBe(200);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1);
  });

  it("many different events in parallel each take effect once (a pass bought twice queues, it does not stack)", async () => {
    const app = await setup({ stores: chaosStores(createInMemoryStores(), 5) });
    const a = transactionEvent({ transactionId: "txn_a", occurredAt: T, customerId: "ctm_1" });
    const b = transactionEvent({ transactionId: "txn_b", occurredAt: T + 1000, customerId: "ctm_1" });
    const results = await Promise.all([app.webhook(a), app.webhook(b), app.webhook(a), app.webhook(b)]);
    for (const r of results) expect([200, 503]).toContain(r.status);
    await app.webhook(a);
    await app.webhook(b);
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(10);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBe(windows[i - 1]!.end);
  });

  it("releases the claim when processing fails, so Paddle's retry is processed (503 now, 200 later)", async () => {
    const app = await setup();
    const ev = firstSubscription();
    const original = app.stores.ledger.ensureWindow.bind(app.stores.ledger);
    app.stores.ledger.ensureWindow = async () => {
      throw new Error("storage hiccup containing customer text");
    };
    const failed = await app.webhook(ev);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await body(failed))).not.toContain("hiccup");
    expect(await app.stores.webhookEvents.get((ev as any).event_id)).toBeNull(); // released, not stuck in processing
    app.stores.ledger.ensureWindow = original;
    expect((await app.webhook(ev)).status).toBe(200);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))).toMatchObject({ state: "processed", attempt: 2 });
  });

  it("repairs a window lost between the plan write and the window write when the event is retried", async () => {
    const app = await setup();
    const ev = firstSubscription();
    const original = app.stores.ledger.ensureWindow.bind(app.stores.ledger);
    app.stores.ledger.ensureWindow = async () => {
      throw new Error("crash after the plan write");
    };
    expect((await app.webhook(ev)).status).toBe(503);
    expect((await app.plan())!.status).toBe("active"); // the plan was written
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]);
    app.stores.ledger.ensureWindow = original;
    expect((await app.webhook(ev)).status).toBe(200);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1);
  });

  it("lets a stale holder finish harmlessly after its claim was taken over", async () => {
    const app = await setup();
    const ev = firstSubscription();
    const store = app.stores.webhookEvents;
    const first = await store.claim({ eventId: (ev as any).event_id, eventType: "subscription.created", occurredAt: T }, app.clock.now(), app.billing.settings.claimStaleAfterMs);
    expect(first.outcome).toBe("claimed");
    // The first worker stalls; a later delivery takes the claim over after the stale time and finishes.
    app.clock.advance(app.billing.settings.claimStaleAfterMs + 1);
    expect((await app.webhook(ev, { at: app.clock.now() })).status).toBe(200);
    expect(await store.get((ev as any).event_id)).toMatchObject({ state: "processed", attempt: 2 });
    // The stalled worker wakes up with its old token and can neither complete nor release.
    expect(await store.complete((ev as any).event_id, 1, "processed", {}, app.clock.now())).toBeNull();
    expect(await store.release((ev as any).event_id, 1)).toBe(false);
  });
});

describe("webhook: ordering", () => {
  it("applies events by occurred_at, not arrival order: an older state change arriving late is ignored", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const pastDue = subscriptionEvent({ type: "subscription.past_due", subscriptionId: "sub_1", status: "past_due", occurredAt: T + 3 * DAY, customerId: "ctm_1" });
    const recovered = subscriptionEvent({ type: "subscription.updated", subscriptionId: "sub_1", status: "active", occurredAt: T + 5 * DAY, customerId: "ctm_1" });
    // Arrival: the newer (recovered) first, then the older past_due.
    await app.webhook(recovered);
    await app.webhook(pastDue);
    expect((await app.plan())!.status).toBe("active");
    // In order: the same two events end in the same state.
    const other = await setup({ accountId: "acc_test" });
    await other.webhook(firstSubscription());
    await other.webhook(pastDue);
    await other.webhook(recovered);
    expect((await other.plan())!.status).toBe("active");
  });

  it("a late cancel-scheduled event does not undo a newer one", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const cancel = subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, scheduled: "cancel", periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" });
    const resume = subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 2 * DAY, scheduled: null, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" });
    await app.webhook(resume);
    await app.webhook(cancel);
    expect((await app.plan())!.cancelAtPeriodEnd).toBe(false);
  });

  it("a payment event that arrives after a newer state event still adds its paid period (facts are order-free)", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const renewalStart = addMonthsUTC(T, 1);
    // The subscription went past_due on the renewal date; the renewal payment's own event is older and arrives late.
    await app.webhook(subscriptionEvent({ type: "subscription.past_due", subscriptionId: "sub_1", status: "past_due", occurredAt: renewalStart + 2 * MIN, customerId: "ctm_1" }));
    expect((await app.stores.ledger.listWindows("acc_test"))).toHaveLength(1);
    await app.webhook(transactionEvent({ transactionId: "txn_renew", subscriptionId: "sub_1", occurredAt: renewalStart + MIN, periodStart: renewalStart, periodEnd: addMonthsUTC(T, 2), customerId: "ctm_1" }));
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.map((w) => w.start)).toEqual([T, renewalStart]);
    expect((await app.plan())!.status).toBe("past_due"); // the newer past_due state stands
  });

  it("an event for a subscription that was replaced does not disturb the current one", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    // Immediate cancellation, then a resubscription with a new subscription id.
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: T + DAY, customerId: "ctm_1" }));
    const second = subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_2", occurredAt: T + 2 * DAY, periodStart: T + 2 * DAY, periodEnd: addMonthsUTC(T + 2 * DAY, 1), customerId: "ctm_1" });
    await app.webhook(second);
    expect((await app.plan())!.paddleSubscriptionId).toBe("sub_2");
    // A late canceled event for the old one arrives: mapped by the customer id, ignored as an old subscription.
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: T + 3 * DAY, customerId: "ctm_1" }));
    expect((await app.plan())).toMatchObject({ paddleSubscriptionId: "sub_2", status: "active" });
    expect(app.notifier.alerts).toEqual([]);
  });
});

describe("webhook: mapping to an account", () => {
  it("quarantines an event for an unknown account id with a 200, alerts, and creates no account or plan", async () => {
    const app = await setup();
    const ev = firstSubscription(T, { accountId: "acc_does_not_exist" });
    const res = await app.webhook(ev);
    expect(res.status).toBe(200);
    const record = await app.stores.webhookEvents.get((ev as any).event_id);
    expect(record).toMatchObject({ state: "quarantined" });
    expect(record!.fields).toEqual({ subscription_id: "sub_1", customer_id: "ctm_1", price_id: PRICE_MONTHLY, status: "active", currency: "EUR", period_start: T, period_end: addMonthsUTC(T, 1) });
    expect(app.notifier.alerts).toEqual([{ kind: "webhook_quarantined", eventId: (ev as any).event_id, reason: "unknown_account" }]);
    expect(await app.stores.accounts.getById("acc_does_not_exist")).toBeNull();
    expect(await app.stores.accounts.findAccountIdByPaddleSubscription("sub_1")).toBeNull();
  });

  it("quarantines an event with no custom_data and no stored ids", async () => {
    const app = await setup();
    const res = await app.webhook(firstSubscription(T, { accountId: null }));
    expect(res.status).toBe(200);
    expect((await app.stores.webhookEvents.listQuarantined())).toHaveLength(1);
    expect(await app.plan()).toBeNull();
  });

  it("binds the first event by custom_data, then maps later events by the stored subscription id", async () => {
    const app = await setup();
    await app.createAccount("acc_other");
    await app.webhook(firstSubscription());
    expect(await app.stores.accounts.findAccountIdByPaddleSubscription("sub_1")).toBe("acc_test");
    expect(await app.stores.accounts.findAccountIdByPaddleCustomer("ctm_1")).toBe("acc_test");
    // A later event that names ANOTHER account in custom_data (crafted or stale) cannot move the subscription.
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, accountId: "acc_other", status: "past_due", customerId: "ctm_1" }));
    expect((await app.plan("acc_test"))!.status).toBe("past_due");
    expect(await app.plan("acc_other")).toBeNull();
    expect(await app.stores.accounts.findAccountIdByPaddleSubscription("sub_1")).toBe("acc_test");
  });

  it("maps an event without custom_data by the stored subscription, and one with only a customer id by the customer", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, accountId: null, status: "past_due", customerId: "ctm_unrelated" }));
    expect((await app.plan())!.status).toBe("past_due"); // found by subscription id
    await app.webhook(adjustmentEvent({ occurredAt: T + 2 * DAY, transactionId: null, customerId: "ctm_1", action: "credit" }));
    expect(await app.stores.webhookEvents.listQuarantined()).toEqual([]); // found by customer id (and ignored: not a refund)
  });

  it("does not bind a purchase to an account that is being deleted without telling the operator", async () => {
    const app = await setup();
    await app.stores.accounts.markDeleting("acc_test", T);
    await app.webhook(firstSubscription());
    expect(app.notifier.alerts).toEqual([{ kind: "purchase_while_deleting", accountId: "acc_test" }]);
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]); // no window for a dying account
  });
});

describe("webhook: what is persisted", () => {
  it("keeps only the allowlisted fields: no name, address, tax id or card detail reaches the ledger or the plan", async () => {
    const app = await setup();
    const ev = firstSubscription(T, { noise: true });
    const secrets = ["Jane Doe", "jane@example.invalid", "1 Rue Exemple", "75001", "4242", "FR12345678901", "Doe SARL", "holder_name", "tax_identifier"];
    await app.webhook(ev);
    const stored = JSON.stringify({
      event: await app.stores.webhookEvents.get((ev as any).event_id),
      plan: await app.plan(),
      windows: await app.stores.ledger.listWindows("acc_test"),
      account: await app.stores.accounts.getById("acc_test"),
    });
    for (const s of secrets) expect(stored, s).not.toContain(s);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))!.fields).toEqual({
      subscription_id: "sub_1",
      customer_id: "ctm_1",
      price_id: PRICE_MONTHLY,
      status: "active",
      currency: "EUR",
      period_start: T,
      period_end: addMonthsUTC(T, 1),
    });
  });

  it("logs nothing about the event: the request log has the route, status and ids of the request only", async () => {
    const app = await setup();
    await app.webhook(firstSubscription(T, { noise: true }));
    const dumped = JSON.stringify(app.t.logs);
    expect(Object.keys(app.t.logs[0]!).sort()).toEqual(["accountId", "creditsCharged", "latencyMs", "method", "requestId", "route", "status"]);
    for (const s of ["sub_1", "ctm_1", "Jane", "evt_", WEBHOOK_SECRET, "h1="]) expect(dumped, s).not.toContain(s);
  });

  it("writes nothing to the console for a normal event, and no body, secret or signature for a failure", async () => {
    const logged: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) => {
      const original = console[m];
      console[m] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      return () => void (console[m] = original);
    });
    try {
      const app = await setup();
      await app.webhook(firstSubscription(T, { noise: true }));
      await app.webhook(firstSubscription(T, { noise: true }), { header: "ts=1;h1=" + "a".repeat(64) });
      app.stores.ledger.ensureWindow = async () => {
        throw new Error("Jane Doe 4242");
      };
      await app.webhook(subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_9", occurredAt: T + 9 * DAY, periodStart: T, periodEnd: T + 30 * DAY, customerId: "ctm_9", noise: true }), { at: T });
    } finally {
      spies.forEach((restore) => restore());
    }
    const text = logged.join("\n");
    for (const s of ["Jane", "4242", "jane@example", WEBHOOK_SECRET, "whsec", "h1=", "sub_9", "ctm_9"]) expect(text, s).not.toContain(s);
  });

  it("records an event type it does not know as processed with no effect", async () => {
    const app = await setup();
    const res = await app.webhook({ event_id: "evt_x", event_type: "customer.updated", occurred_at: "2026-11-01T09:30:00Z", data: { id: "ctm_1", name: "Jane Doe" } });
    expect(res.status).toBe(200);
    expect(await app.stores.webhookEvents.get("evt_x")).toMatchObject({ state: "processed", fields: {} });
    expect(await app.plan()).toBeNull();
  });
});

describe("webhook: the purchase flows end to end", () => {
  it("a monthly subscription gets a window for each paid period and renewal never resets a budget", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + 1000, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    let windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ start: T, end: addMonthsUTC(T, 1), limit: 12_500, source: "paddle", used: 0 });
    // Spend some of it, then replay and renew.
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 700, now: T + 5000, expiresAt: T + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 700, logicalModelId: "m", now: T + 6000 });
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    const renewal = addMonthsUTC(T, 1);
    await app.webhook(transactionEvent({ transactionId: "txn_2", subscriptionId: "sub_1", occurredAt: renewal + MIN, periodStart: renewal, periodEnd: addMonthsUTC(T, 2), customerId: "ctm_1" }));
    windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.map((w) => [w.start, w.used])).toEqual([[T, 700], [renewal, 0]]);
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 1000)).toMatchObject({ used: 700 });
  });

  it("past_due lets the current window run to its end and starts no new window until the payment succeeds", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const renewal = addMonthsUTC(T, 1);
    await app.webhook(subscriptionEvent({ type: "subscription.past_due", subscriptionId: "sub_1", status: "past_due", occurredAt: renewal + MIN, periodStart: renewal, periodEnd: addMonthsUTC(T, 2), customerId: "ctm_1" }));
    expect((await app.plan())!.status).toBe("past_due");
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1); // no window for the unpaid period
    expect(await app.stores.ledger.getCurrentWindow("acc_test", renewal - 1)).not.toBeNull(); // the current one runs to its end
    expect(await app.stores.ledger.getCurrentWindow("acc_test", renewal + 1)).toBeNull();
    // Payment succeeds: the new window starts at the period Paddle reports.
    await app.webhook(transactionEvent({ transactionId: "txn_2", subscriptionId: "sub_1", occurredAt: renewal + 3 * DAY, periodStart: renewal, periodEnd: addMonthsUTC(T, 2), customerId: "ctm_1" }));
    expect((await app.plan())!.status).toBe("active");
    expect((await app.stores.ledger.listWindows("acc_test")).map((w) => w.start)).toEqual([T, renewal]);
  });

  it("a semester pass gets five consecutive windows from its start; a replay or a second delivery adds none", async () => {
    const app = await setup();
    const pass = transactionEvent({ transactionId: "txn_pass", occurredAt: T, customerId: "ctm_1" });
    await app.webhook(pass);
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(5);
    expect(windows[0]!.start).toBe(T);
    expect(windows[4]!.end).toBe(addMonthsUTC(T, 5));
    windows.forEach((w, i) => i > 0 && expect(w.start).toBe(windows[i - 1]!.end));
    // Another event id for the same transaction (Paddle can send transaction.completed twice) adds nothing.
    await app.webhook({ ...(pass as any), event_id: "evt_again" });
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(5);
    expect(await app.plan()).toMatchObject({ planId: "plus_semester", status: "active", paddleSubscriptionId: null });
  });

  it("a pass bought while a pass is active queues after the current windows; budgets never stack", async () => {
    const app = await setup();
    await app.webhook(transactionEvent({ transactionId: "txn_a", occurredAt: T, customerId: "ctm_1" }));
    const later = T + 40 * DAY;
    await app.webhook(transactionEvent({ transactionId: "txn_b", occurredAt: later, customerId: "ctm_1" }));
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(10);
    expect(windows[5]!.start).toBe(addMonthsUTC(T, 5)); // the second pass starts where the first ends
    expect(windows[9]!.end).toBe(addMonthsUTC(addMonthsUTC(T, 5), 5));
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBe(windows[i - 1]!.end);
    // Never two windows open at once.
    for (const at of [T, later, addMonthsUTC(T, 5), addMonthsUTC(T, 7)]) {
      expect(windows.filter((w) => w.start <= at && at < w.end)).toHaveLength(1);
    }
  });

  it("a pass after the previous one ended starts at its own purchase", async () => {
    const app = await setup();
    await app.webhook(transactionEvent({ transactionId: "txn_a", occurredAt: T, customerId: "ctm_1" }));
    const after = addMonthsUTC(T, 5) + 3 * DAY;
    await app.webhook(transactionEvent({ transactionId: "txn_b", occurredAt: after, customerId: "ctm_1" }));
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(10);
    expect(windows[5]!.start).toBe(after);
  });

  it("quarantines a payment that would stack a second plan (a subscription bought during a pass, a pass during a subscription)", async () => {
    const app = await setup();
    await app.webhook(transactionEvent({ transactionId: "txn_pass", occurredAt: T, customerId: "ctm_1" }));
    const sub = subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_late", occurredAt: T + DAY, periodStart: T + DAY, periodEnd: addMonthsUTC(T + DAY, 1), customerId: "ctm_1" });
    await app.webhook(sub);
    expect((await app.stores.webhookEvents.get((sub as any).event_id))!.state).toBe("quarantined");
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(5);

    const other = await setup();
    await other.webhook(firstSubscription());
    const pass = transactionEvent({ transactionId: "txn_pass", occurredAt: T + DAY, customerId: "ctm_1" });
    await other.webhook(pass);
    expect((await other.stores.webhookEvents.get((pass as any).event_id))!.state).toBe("quarantined");
    expect(await other.stores.ledger.listWindows("acc_test")).toHaveLength(1);
    expect(other.notifier.alerts.map((a) => (a as any).reason)).toEqual(["plan_conflict"]);
  });

  it("quarantines a second subscription while the first runs, and a product it does not know", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const dup = subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_dup", occurredAt: T + DAY, periodStart: T + DAY, periodEnd: addMonthsUTC(T + DAY, 1), customerId: "ctm_1" });
    await app.webhook(dup);
    expect((await app.stores.webhookEvents.get((dup as any).event_id))!.state).toBe("quarantined");
    expect((await app.plan())!.paddleSubscriptionId).toBe("sub_1");

    const other = await setup();
    const wrongProduct = firstSubscription(T, { priceId: "pri_something_else" });
    await other.webhook(wrongProduct);
    expect((await other.stores.webhookEvents.get((wrongProduct as any).event_id))!.state).toBe("quarantined");
    expect(await other.stores.ledger.listWindows("acc_test")).toEqual([]);
    // A one-time payment for another product is simply not ours.
    const otherPayment = transactionEvent({ transactionId: "txn_other", occurredAt: T, priceId: "pri_book" });
    await other.webhook(otherPayment);
    expect((await other.stores.webhookEvents.get((otherPayment as any).event_id))!.state).toBe("processed");
    expect(await other.stores.ledger.listWindows("acc_test")).toEqual([]);
  });

  it("refuses a billing period that is not a month rather than granting it", async () => {
    const app = await setup();
    const ev = firstSubscription(T, {});
    (ev as any).data.current_billing_period.ends_at = new Date(T + 400 * DAY).toISOString();
    await app.webhook(ev);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]);
  });

  it("trialing and unknown statuses buy nothing", async () => {
    const app = await setup();
    await app.webhook(firstSubscription(T, { status: "trialing" }));
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]);
    expect(await app.plan()).toBeNull();
  });
});

describe("webhook: cancellation, refunds and chargebacks", () => {
  it("a cancel scheduled for the period end sets the flag; the window runs to its end and no new one starts", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const end = addMonthsUTC(T, 1);
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 2 * DAY, scheduled: "cancel", periodStart: T, periodEnd: end, customerId: "ctm_1" }));
    expect(await app.plan()).toMatchObject({ cancelAtPeriodEnd: true, status: "active" });
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: end, customerId: "ctm_1" }));
    expect(await app.plan()).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ end, revokedAt: null }); // the paid period was honored to its end
  });

  it("an immediate cancellation ends the running window at that instant, keeping used credits", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 40, now: T + 1000, expiresAt: T + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 40, logicalModelId: "m", now: T + 2000 });
    const at = T + 10 * DAY;
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: at, customerId: "ctm_1" }));
    const [w] = await app.stores.ledger.listWindows("acc_test");
    expect(w).toMatchObject({ end: at, used: 40 });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", at)).toBeNull();
    expect((await app.plan())!.paidPeriods[0]!.end).toBe(at);
  });

  it("a refund revokes the current window and a queued pass, and stops the renewals", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    app.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
    await app.webhook(adjustmentEvent({ occurredAt: T + 3 * DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    expect(await app.plan()).toMatchObject({ status: "revoked", pendingCancel: null });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 4 * DAY)).toBeNull();
    // The renewals are stopped at Paddle (a refund does not cancel by itself).
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "immediately"]]);
    expect(app.paddle.subscriptions.get("sub_1")!.status).toBe("canceled");
  });

  it("a chargeback revokes a semester pass: the current and the future windows, all of them", async () => {
    const app = await setup();
    await app.webhook(transactionEvent({ transactionId: "txn_pass", occurredAt: T, customerId: "ctm_1" }));
    await app.webhook(adjustmentEvent({ occurredAt: T + 40 * DAY, transactionId: "txn_pass", action: "chargeback", customerId: "ctm_1" }));
    const windows = await app.stores.ledger.listWindows("acc_test");
    // The first month ended before the chargeback (history); the running month and the three later ones are withdrawn.
    expect(windows.map((w) => w.revokedAt !== null)).toEqual([false, true, true, true, true]);
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 41 * DAY)).toBeNull();
    expect((await app.plan())!.status).toBe("revoked");
  });

  it("only an approved refund or chargeback revokes: pending, rejected, reversed and credits do not", async () => {
    const app = await setup();
    await app.webhook(transactionEvent({ transactionId: "txn_pass", occurredAt: T, customerId: "ctm_1" }));
    for (const [action, status] of [["refund", "pending_approval"], ["refund", "rejected"], ["refund", "reversed"], ["credit", "approved"], ["chargeback_warning", "approved"]] as const) {
      await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_pass", action, status, customerId: "ctm_1" }));
    }
    expect((await app.plan())!.status).toBe("active");
    expect((await app.stores.ledger.listWindows("acc_test")).every((w) => w.revokedAt === null)).toBe(true);
  });

  it("a refund delivered before its payment's event leaves no free window behind", async () => {
    const app = await setup();
    await app.webhook(transactionEvent({ transactionId: "txn_old", occurredAt: T - 200 * DAY, customerId: "ctm_1" }), { at: T }); // an earlier pass, long over
    const refund = adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_new", action: "refund", customerId: "ctm_1" });
    await app.webhook(refund);
    // The payment for txn_new arrives afterwards (reordered delivery).
    await app.webhook(transactionEvent({ transactionId: "txn_new", occurredAt: T, customerId: "ctm_1" }));
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
    expect((await app.plan())!.paidPeriods.filter((p) => p.purchaseId === "txn_new").every((p) => p.revokedAt !== undefined)).toBe(true);
  });

  it("a refunded subscription stays withdrawn: its later events do not bring it back, a new purchase does", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 2 * DAY, periodStart: T + 2 * DAY, periodEnd: addMonthsUTC(T + 2 * DAY, 1), customerId: "ctm_1" }));
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 3 * DAY)).toBeNull();
    const again = subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_2", occurredAt: T + 5 * DAY, periodStart: T + 5 * DAY, periodEnd: addMonthsUTC(T + 5 * DAY, 1), customerId: "ctm_1" });
    await app.webhook(again);
    expect(await app.plan()).toMatchObject({ status: "active", paddleSubscriptionId: "sub_2" });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 6 * DAY)).toMatchObject({ start: T + 5 * DAY });
  });

  it("replaying a purchase after a refund buys nothing, whatever the event id", async () => {
    const app = await setup();
    const pass = transactionEvent({ transactionId: "txn_pass", occurredAt: T, customerId: "ctm_1" });
    await app.webhook(pass);
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_pass", customerId: "ctm_1" }));
    await app.webhook({ ...(pass as any), event_id: "evt_replayed_pass" });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
    expect((await app.stores.ledger.listWindows("acc_test")).every((w) => w.revokedAt !== null)).toBe(true);
  });
});

describe("webhook: the plan version", () => {
  it("moves on a real change only, so a harmless duplicate does not make clients refetch", async () => {
    const app = await setup();
    await app.webhook(firstSubscription());
    const v1 = (await app.stores.accounts.getById("acc_test"))!.planVersion;
    expect(v1).toBeGreaterThan(0);
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(v1);
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 2 * DAY, status: "past_due", customerId: "ctm_1" }));
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(v1 + 1);
  });
});

describe("webhook: ids the two kinds of price", () => {
  it("uses the semester price for a pass and the monthly price for a subscription, by configuration", async () => {
    expect(PRICE_MONTHLY).not.toBe(PRICE_SEMESTER);
    const app = await setup();
    // A one-time payment at the MONTHLY price is not a pass: a monthly price belongs to subscriptions.
    await app.webhook(transactionEvent({ transactionId: "txn_x", occurredAt: T, priceId: PRICE_MONTHLY, customerId: "ctm_1" }));
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]);
  });
});
