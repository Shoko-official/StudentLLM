// Tests for the review round of the billing module: each one fails without the change it pins.

import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../config";
import { createInMemoryStores } from "../../storage";
import { TEST_START_MS, testEnv } from "../../testing";
import {
  adjustmentEvent,
  makeBillingTestApp,
  subscriptionEvent,
  transactionEvent,
  type BillingTestApp,
} from "../../testing/billing-test-app";
import { chaosStores } from "../../testing/store-contract";
import { createBillingDeps } from "./index";
import { envFromDeps } from "./env";
import { createGrantWindows } from "./grants";
import { COMPLIMENTARY_PLAN_ID, toPublicPlan } from "./plan-model";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const JSON_HEADERS = { "Content-Type": "application/json" };

async function setup(options: Parameters<typeof makeBillingTestApp>[0] = {}, customerId: string | null = "ctm_1"): Promise<BillingTestApp> {
  const app = makeBillingTestApp(options);
  await app.createAccount(undefined, undefined, customerId);
  return app;
}

const monthly = (at: number, id = "sub_1", extra: Record<string, unknown> = {}) =>
  subscriptionEvent({ type: "subscription.created", subscriptionId: id, occurredAt: at, periodStart: at, periodEnd: addMonthsUTC(at, 1), customerId: "ctm_1", ...extra });
const pass = (txn: string, at: number, extra: Record<string, unknown> = {}) => transactionEvent({ transactionId: txn, occurredAt: at, customerId: "ctm_1", ...extra });
const checkout = (app: BillingTestApp, plan = "plus_monthly") =>
  app.as("/v1/billing/checkout", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ plan }) });
const runCron = (app: BillingTestApp) => app.t.app.scheduled({ scheduledTime: app.clock.now(), cron: "* * * * *" });
const liveWindows = async (app: BillingTestApp) => (await app.stores.ledger.listWindows("acc_test")).filter((w) => w.revokedAt === null);

describe("review 1: a chargeback or refund is not lost", () => {
  it("resolves an adjustment by the payment it names, whatever customer id it carries", async () => {
    const app = await setup();
    await app.webhook(pass("txn_p", T));
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_p", action: "chargeback", customerId: "ctm_not_stored" }));
    expect(await app.stores.webhookEvents.listQuarantined()).toEqual([]);
    expect(await app.plan()).toMatchObject({ status: "revoked" });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
  });

  it("quarantines a chargeback that arrives before the first purchase and applies it when the purchase is applied", async () => {
    const app = await setup({}, null); // a fresh account: nothing stored that could identify the chargeback
    const chargeback = adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_x", action: "chargeback", customerId: "ctm_1" });
    expect((await app.webhook(chargeback)).status).toBe(200);
    expect((await app.stores.webhookEvents.listQuarantined()).map((e) => e.eventId)).toEqual([(chargeback as any).event_id]);
    expect(app.notifier.reviews).toEqual([{ kind: "chargeback", accountId: "unknown", transactionId: "txn_x" }]);

    await app.webhook(pass("txn_x", T)); // the purchase it refers to, delivered late
    expect(await app.stores.webhookEvents.listQuarantined()).toEqual([]); // replayed and marked processed
    expect(await app.stores.webhookEvents.get((chargeback as any).event_id)).toMatchObject({ state: "processed" });
    expect((await app.plan())!.paidPeriods.every((p) => p.revokedAt !== undefined)).toBe(true);
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
    expect(await liveWindows(app)).toEqual([]);
  });

  it("does not replay a quarantined adjustment that belongs to another payment", async () => {
    const app = await setup({}, null);
    const unrelated = adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_other", action: "chargeback", customerId: "ctm_9" });
    await app.webhook(unrelated);
    await app.webhook(pass("txn_mine", T));
    expect(await app.stores.webhookEvents.listQuarantined()).toHaveLength(1);
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).not.toBeNull();
  });

  it("keeps resolving through the customer ids and payments an account used (the indexes never forget)", async () => {
    const app = await setup();
    await app.webhook(pass("txn_p", T));
    expect(await app.stores.accounts.findAccountIdByPurchase("txn_p")).toBe("acc_test");
    expect(await app.stores.accounts.findAccountIdByPurchase("txn_none")).toBeNull();
    // Even a plan that moved on to another customer id still resolves the old one.
    const account = (await app.stores.accounts.getById("acc_test"))!;
    const plan = (await app.plan())!;
    await app.stores.accounts.savePlan({ ...plan, paddleCustomerId: "ctm_new", retiredCustomerIds: ["ctm_1"] }, { expectedPlanVersion: account.planVersion });
    expect(await app.stores.accounts.findAccountIdByPaddleCustomer("ctm_1")).toBe("acc_test");
    expect(await app.stores.accounts.findAccountIdByPaddleCustomer("ctm_new")).toBe("acc_test");
  });
});

describe("review 2: refund semantics", () => {
  it("a partial refund changes nothing and asks an operator to look; a refund with no type is treated the same", async () => {
    for (const adjustmentType of ["partial", null] as const) {
      const app = await setup();
      await app.webhook(pass("txn_p", T));
      const version = (await app.stores.accounts.getById("acc_test"))!.planVersion;
      await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_p", adjustmentType, customerId: "ctm_1" }));
      expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(version);
      expect((await app.plan())!.status).toBe("active");
      expect(await liveWindows(app)).toHaveLength(5);
      expect(app.notifier.alerts).toEqual([{ kind: "partial_refund", accountId: "acc_test", transactionId: "txn_p" }]);
      expect(app.paddle.callsTo("cancelSubscription")).toEqual([]);
    }
  });

  it("a full refund revokes, and a chargeback revokes whatever its type", async () => {
    const full = await setup();
    await full.webhook(pass("txn_p", T));
    await full.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_p", adjustmentType: "full", customerId: "ctm_1" }));
    expect((await full.plan())!.status).toBe("revoked");
    const cb = await setup();
    await cb.webhook(pass("txn_p", T));
    await cb.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_p", action: "chargeback", adjustmentType: "partial", customerId: "ctm_1" }));
    expect((await cb.plan())!.status).toBe("revoked");
    expect(cb.notifier.reviews).toEqual([{ kind: "chargeback", accountId: "acc_test", transactionId: "txn_p" }]);
  });

  it("a partial refund does not cancel the subscription; a full one does, immediately", async () => {
    const partial = await setup();
    await partial.webhook(monthly(T));
    await partial.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    await partial.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", adjustmentType: "partial", customerId: "ctm_1" }));
    expect(partial.paddle.callsTo("cancelSubscription")).toEqual([]);
    expect((await partial.plan())!.pendingCancel ?? null).toBeNull();

    const full = await setup();
    await full.webhook(monthly(T));
    await full.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    await full.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    expect(full.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "immediately"]]);
  });

  it("a refund of another payment does not take the running window", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    await app.webhook(transactionEvent({ transactionId: "txn_now", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_last_month", customerId: "ctm_1" }));
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).not.toBeNull();
    expect((await app.plan())!.status).toBe("active");
  });

  it("fills in the paying transaction of a period first seen without it, so a later refund finds it", async () => {
    const app = await setup();
    await app.webhook(monthly(T)); // the subscription event carries the period but not the payment
    expect((await app.plan())!.paidPeriods[0]!.purchaseId).toBeUndefined();
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    expect((await app.plan())!.paidPeriods).toHaveLength(1);
    expect((await app.plan())!.paidPeriods[0]!.purchaseId).toBe("txn_1");
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
  });

  it("a refund delivered before the payment event that names the same period leaves no free window", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).not.toBeNull(); // nothing yet ties txn_1 to the period
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }), { at: app.clock.now() });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
  });
});

describe("review 3: a duplicate subscription is canceled, not just quarantined", () => {
  const duplicate = (at: number, id = "sub_dup") => monthly(at, id);

  it("cancels the duplicate by its subscription id, now, and tells the operator which subscription and customer", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    app.paddle.subscriptions.set("sub_dup", { id: "sub_dup", status: "active", customerId: "ctm_1", periodStart: T + DAY, periodEnd: addMonthsUTC(T + DAY, 1), cancelScheduled: false });
    const ev = duplicate(T + DAY);
    await app.webhook(ev);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_dup", "immediately"]]);
    expect(app.notifier.alerts).toEqual([{ kind: "webhook_quarantined", eventId: (ev as any).event_id, reason: "duplicate_subscription", subscriptionId: "sub_dup", customerId: "ctm_1" }]);
    expect(await app.plan()).toMatchObject({ paddleSubscriptionId: "sub_1", extraCancels: [] });
    expect(await liveWindows(app)).toHaveLength(1); // the duplicate bought no window
  });

  it("keeps a retry record when Paddle fails, retries it with backoff, and refuses another checkout meanwhile", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    app.paddle.failNext("cancelSubscription", "unavailable");
    await app.webhook(duplicate(T + DAY));
    const pending = (await app.plan())!.extraCancels!;
    expect(pending).toMatchObject([{ subscriptionId: "sub_dup", customerId: "ctm_1", reason: "duplicate", attempts: 1 }]);
    expect(await app.stores.accounts.listPendingCancels(pending[0]!.nextAttemptAt, 10)).toEqual(["acc_test"]);
    expect((await checkout(app, "plus_semester")).status).toBe(409); // already_subscribed until the duplicate is gone
    app.clock.set(pending[0]!.nextAttemptAt);
    await runCron(app);
    expect(app.paddle.callsTo("cancelSubscription")).toHaveLength(2);
    expect((await app.plan())!.extraCancels).toEqual([]);
  });

  it("a duplicate that is canceled at Paddle ends its retry when the canceled event arrives", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    app.paddle.failNext("cancelSubscription", "unavailable");
    await app.webhook(duplicate(T + DAY));
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_dup", status: "canceled", occurredAt: T + 2 * DAY, customerId: "ctm_1" }));
    expect((await app.plan())!.extraCancels).toEqual([]);
  });

  it("a subscription bought during a pass is canceled too; a pass during a subscription has nothing to cancel", async () => {
    const app = await setup();
    await app.webhook(pass("txn_p", T));
    await app.webhook(duplicate(T + DAY, "sub_late"));
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_late", "immediately"]]);
    const other = await setup();
    await other.webhook(monthly(T));
    await other.webhook(pass("txn_p", T + DAY));
    expect(other.paddle.callsTo("cancelSubscription")).toEqual([]);
  });

  it("deleting the account cancels the main subscription and every duplicate, and keeps all ids until then", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    app.paddle.failNext("cancelSubscription", "unavailable", 1);
    await app.webhook(duplicate(T + DAY));
    const tombstone = await app.stores.accounts.markDeleting("acc_test", T + 2 * DAY);
    expect(tombstone!.paddleSubscriptionIds.sort()).toEqual(["sub_1", "sub_dup"]);
    expect(tombstone!.paddleCustomerIds).toEqual(["ctm_1"]);
    app.paddle.failNext("cancelSubscription", "unavailable", 1); // the duplicate fails again, the main one succeeds
    app.paddle.calls.length = 0;
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
    expect((await app.plan())!.extraCancels).toEqual([]);
    expect(app.paddle.callsTo("cancelSubscription").map((c) => c[0])).toContain("sub_dup");
  });

  it("narrows the parallel-checkout race with a per-account lock", async () => {
    const app = await setup();
    const release = app.paddle.hold("createTransaction");
    const first = checkout(app);
    while (app.paddle.callsTo("createTransaction").length === 0) await new Promise((r) => setTimeout(r, 1));
    const second = await checkout(app); // arrives while the first still holds the lock
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error.code).toBe("concurrency_limit");
    expect(second.headers.get("Retry-After")).toBe("5");
    release();
    expect((await first).status).toBe(200);
    expect((await checkout(app)).status).toBe(200); // the lock was released
    expect(app.paddle.callsTo("createTransaction")).toHaveLength(2);
  });

  it("releases the checkout lock when Paddle fails", async () => {
    const app = await setup();
    app.paddle.failNext("createTransaction", "unavailable");
    expect((await checkout(app)).status).toBe(503);
    expect((await checkout(app)).status).toBe(200);
  });
});

describe("review 4 and 5: grants are atomic, idempotent, and cut by grant", () => {
  async function grantApp(options: Parameters<typeof makeBillingTestApp>[0] = {}) {
    const app = await setup(options);
    const env = envFromDeps(app.t.deps);
    return { app, env, grant: (req: Parameters<typeof createGrantWindows>[2]) => createGrantWindows(env, "acc_test", req) };
  }

  it("parallel grants for the same time: exactly one wins, whole, under reordering storage", async () => {
    const { app, grant } = await grantApp({ stores: chaosStores(createInMemoryStores(), 17) });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => grant({ grantId: `grt_${i}`, days: 60, startPolicy: "now" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, reason: "window_overlap" });
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows).toHaveLength(2); // all of the winner's windows, none of the losers'
    expect(new Set(windows.map((w) => w.grantId)).size).toBe(1);
  });

  it("parallel replays of one grant create its windows once", async () => {
    const { app, grant } = await grantApp({ stores: chaosStores(createInMemoryStores(), 23) });
    const results = await Promise.all(Array.from({ length: 5 }, () => grant({ grantId: "grt_same", days: 45, startPolicy: "now", startsAt: T })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(2);
    expect(results.filter((r) => r.ok && !r.existed)).toHaveLength(1);
  });

  it("a replay at a later time returns the windows unchanged instead of recomputing them", async () => {
    const { app, grant } = await grantApp();
    const first = await grant({ grantId: "g", days: 30, startPolicy: "now" });
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 9, now: T + 1000, expiresAt: T + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 9, logicalModelId: "m", now: T + 2000 });
    app.clock.set(T + 3 * DAY);
    const replay = await grant({ grantId: "g", days: 30, startPolicy: "now" });
    expect(first.ok && replay.ok && replay.existed && replay.startsAt === first.startsAt).toBe(true);
    expect((await app.stores.ledger.getCurrentWindow("acc_test", T + 3 * DAY))!.used).toBe(9);
    const version = (await app.stores.accounts.getById("acc_test"))!.planVersion;
    await grant({ grantId: "g", days: 30, startPolicy: "now" });
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(version); // a replay does not bump it
  });

  it("an explicit startsAt is used as given", async () => {
    const { grant } = await grantApp();
    expect(await grant({ grantId: "g", days: 10, startPolicy: "now", startsAt: T + 5 * DAY })).toMatchObject({ ok: true, startsAt: T + 5 * DAY, endsAt: T + 15 * DAY });
  });

  it("a purchase shortens the WHOLE grant, including windows that do not overlap the paid period, and reports what it cut", async () => {
    const { app, grant } = await grantApp();
    await grant({ grantId: "g", days: 90, creditsPerWindow: 3000, startPolicy: "now" });
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 100, now: T + DAY, expiresAt: T + DAY + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 100, logicalModelId: "m", now: T + DAY + 1 });
    const at = T + 10 * DAY;
    await app.webhook(monthly(at));
    // The paid month ends about day 40; the grant's third window (days 60 to 90) does not overlap it, and is gone.
    const grantWindows = (await app.stores.ledger.listWindows("acc_test")).filter((w) => w.source === "admin_grant");
    expect(grantWindows.map((w) => [w.start - T, w.end - T, w.used])).toEqual([[0, 10 * DAY, 100]]);
    expect(app.notifier.grantCuts).toHaveLength(1);
    expect(app.notifier.grantCuts[0]!.cuts.map((c) => [c.windowStart - T, c.previousEnd - T, c.newEnd === null ? null : c.newEnd - T, c.used, c.remaining])).toEqual([
      [0, 30 * DAY, 10 * DAY, 100, 2900],
      [30 * DAY, 60 * DAY, null, 0, 3000],
      [60 * DAY, 90 * DAY, null, 0, 3000],
    ]);
    for (const instant of [T, at - 1, at, addMonthsUTC(at, 1) - 1]) {
      expect((await liveWindows(app)).filter((w) => w.start <= instant && instant < w.end)).toHaveLength(1);
    }
  });
});

describe("review 6: the Paddle customer is created on the server", () => {
  it("creates the customer from the verified email, stores it, and always passes it to the transaction", async () => {
    const app = await setup({}, null);
    expect((await checkout(app)).status).toBe(200);
    expect(app.paddle.callsTo("createCustomer")).toEqual([[{ email: "acc_test@example.invalid", accountId: "acc_test" }]]);
    expect(await app.plan()).toMatchObject({ paddleCustomerId: "ctm_fake_1", paidPeriods: [], status: "none" });
    expect(app.paddle.callsTo("createTransaction")[0]![0]).toMatchObject({ customerId: "ctm_fake_1" });
    expect((await checkout(app)).status).toBe(200);
    expect(app.paddle.callsTo("createCustomer")).toHaveLength(1); // reused
    expect(app.paddle.callsTo("createTransaction")[1]![0]).toMatchObject({ customerId: "ctm_fake_1" });
    // The customer is also what the portal opens.
    expect((await app.as("/v1/billing/portal")).status).toBe(200);
  });

  it("answers a Paddle failure while creating the customer with provider_unavailable and stores nothing", async () => {
    const app = await setup({}, null);
    app.paddle.failNext("createCustomer", "unavailable");
    const res = await checkout(app);
    expect(res.status).toBe(503);
    expect(await app.plan()).toBeNull();
    expect(app.paddle.callsTo("createTransaction")).toEqual([]);
  });

  it("quarantines a first event whose customer id differs from the stored one", async () => {
    const app = await setup(); // the stored customer is ctm_1
    const ev = monthly(T, "sub_1", { customerId: "ctm_other" });
    await app.webhook(ev);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
    expect(app.notifier.alerts).toEqual([{ kind: "webhook_quarantined", eventId: (ev as any).event_id, reason: "customer_mismatch", subscriptionId: "sub_1", customerId: "ctm_other" }]);
    expect(await liveWindows(app)).toEqual([]);
    const passEv = pass("txn_p", T, { customerId: "ctm_other" });
    await app.webhook(passEv);
    expect(await liveWindows(app)).toEqual([]);
  });

  it("alerts the operator when an account adopts a customer id from an event", async () => {
    const app = await setup({}, null);
    await app.webhook(monthly(T));
    expect((await app.plan())!.paddleCustomerId).toBe("ctm_1");
    expect(app.notifier.alerts).toEqual([{ kind: "customer_adopted", accountId: "acc_test", customerId: "ctm_1" }]);
  });
});

describe("review 7: grant ceilings come from the standard window W", () => {
  it("refuses a window above W and totals above 3W, and accepts exactly W", async () => {
    const app = await setup({ env: { PLUS_MONTHLY_WINDOW_CREDITS: "1000" } });
    const grant = (req: Parameters<typeof createGrantWindows>[2]) => createGrantWindows(envFromDeps(app.t.deps), "acc_test", req);
    expect(await grant({ grantId: "a", days: 30, creditsPerWindow: 1001, startPolicy: "now" })).toEqual({ ok: false, reason: "limit_exceeded", limit: "grant_max_credits_per_window" });
    expect(await grant({ grantId: "b", days: 90, creditsPerWindow: 1000, startPolicy: "now" })).toMatchObject({ ok: true });
    expect((await app.stores.ledger.listWindows("acc_test")).reduce((s, w) => s + w.limit, 0)).toBe(3000); // 3W, never more
    expect(await liveWindows(app)).toHaveLength(3);
  });

  it("needs an account that exists and is active", async () => {
    const app = await setup();
    const grant = (id: string) => createGrantWindows(envFromDeps(app.t.deps), id, { grantId: "g", days: 5, startPolicy: "now" });
    expect(await grant("ghost")).toEqual({ ok: false, reason: "account_not_active" });
    await app.stores.accounts.update("acc_test", { status: "suspended" });
    expect(await grant("acc_test")).toEqual({ ok: false, reason: "account_not_active" });
    await app.stores.accounts.update("acc_test", { status: "deleting" });
    expect(await grant("acc_test")).toEqual({ ok: false, reason: "account_not_active" });
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual([]);
  });
});

describe("review 8: a new subscription does not wipe a pending cancel", () => {
  it("moves the pending cancel of the replaced subscription to the extra cancellations and keeps retrying it", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + MIN, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    app.paddle.failNext("cancelSubscription", "unavailable", 99);
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    expect((await app.plan())!.pendingCancel).toMatchObject({ attempts: 1 });
    // A new subscription replaces sub_1 while its cancellation is still pending.
    await app.webhook(monthly(T + 2 * DAY, "sub_2"));
    const plan = (await app.plan())!;
    expect(plan.paddleSubscriptionId).toBe("sub_2");
    expect(plan.pendingCancel ?? null).toBeNull();
    expect(plan.extraCancels).toMatchObject([{ subscriptionId: "sub_1", reason: "retired", attempts: 1 }]);
    // Paddle recovers: the cron cancels the old subscription.
    app.paddle.calls.length = 0;
    app.clock.advance(app.billing.settings.cancel.maxDelayMs);
    app.paddle.clearFailures();
    app.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "canceled", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
    await runCron(app);
    expect((await app.plan())!.extraCancels).toEqual([]);
  });

  it("cancels a replaced subscription that Paddle may still hold alive (a paused one)", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    await app.webhook(subscriptionEvent({ type: "subscription.paused", subscriptionId: "sub_1", status: "paused", occurredAt: T + DAY, customerId: "ctm_1" }));
    app.clock.set(addMonthsUTC(T, 1) + DAY); // the paid period is over, the pause is in force
    await app.webhook(monthly(app.clock.now(), "sub_2"));
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "immediately"]]);
  });
});

describe("review 9 to 16", () => {
  it("9: refuses a subscription period shorter than 25 days or longer than 62, accepts the edges", async () => {
    for (const [days, ok] of [[10, false], [24, false], [25, true], [31, true], [62, true], [63, false]] as const) {
      const app = await setup();
      const ev = monthly(T, "sub_1", {});
      (ev as any).data.current_billing_period.ends_at = new Date(T + days * DAY).toISOString();
      await app.webhook(ev);
      expect((await liveWindows(app)).length, `${days} days`).toBe(ok ? 1 : 0);
    }
  });

  it("10: an event far in the future cannot freeze the plan: ordering is clamped to now plus the tolerance", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    const farFuture = subscriptionEvent({ subscriptionId: "sub_1", status: "past_due", occurredAt: T + 365 * DAY, customerId: "ctm_1" });
    await app.webhook(farFuture, { at: T }); // signed now, claims to have happened a year ahead
    expect((await app.plan())!.status).toBe("past_due");
    expect((await app.plan())!.lastEventAt).toBe(T + app.billing.settings.signatureToleranceMs);
    // A genuine later event is not stale.
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", status: "active", occurredAt: T + 2 * DAY, customerId: "ctm_1" }));
    expect((await app.plan())!.status).toBe("active");
  });

  it("12: a paused subscription is not marked canceled and is still canceled at Paddle on deletion", async () => {
    const app = await setup();
    await app.webhook(monthly(T));
    await app.webhook(subscriptionEvent({ type: "subscription.paused", subscriptionId: "sub_1", status: "paused", occurredAt: T + DAY, customerId: "ctm_1" }));
    expect(await app.plan()).toMatchObject({ status: "active", cancelAtPeriodEnd: true, paddleSubscriptionId: "sub_1" });
    expect(await liveWindows(app)).toHaveLength(1); // the paid period is honored
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "immediately"]]);
  });

  it("13: a Paddle API key of the other environment stops the deps from being built", () => {
    const core = (env: Record<string, string>) => {
      const config = loadConfig(testEnv(env));
      return { config, clock: { now: () => T }, stores: createInMemoryStores(), ids: { requestId: () => "r" }, fetch: (() => {
        throw new Error("no network");
      }) as typeof fetch, log: { request: () => undefined } };
    };
    expect(() => createBillingDeps(core({ PADDLE_ENVIRONMENT: "live", PADDLE_API_KEY: `pdl_sdbx_apikey_${"x".repeat(32)}` }))).toThrow(ConfigError);
    expect(() => createBillingDeps(core({ PADDLE_ENVIRONMENT: "sandbox", PADDLE_API_KEY: `pdl_live_apikey_${"x".repeat(32)}` }))).toThrow(ConfigError);
    expect(() => createBillingDeps(core({ PADDLE_ENVIRONMENT: "sandbox", PADDLE_API_KEY: `pdl_sdbx_apikey_${"x".repeat(32)}` }))).not.toThrow();
  });

  it("14: a checkout URL on a host that is not configured is never returned", async () => {
    const app = await setup();
    app.paddle.checkoutHost = "evil.example.invalid";
    const res = await checkout(app);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("evil");
  });

  it("15: a completed transaction without items is quarantined, not trusted", async () => {
    const app = await setup();
    const ev = transactionEvent({ transactionId: "txn_x", subscriptionId: "sub_1", occurredAt: T, periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" });
    (ev as any).data.items = [];
    await app.webhook(ev);
    expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
    const noItemsAtAll = pass("txn_y", T);
    delete (noItemsAtAll as any).data.items;
    await app.webhook(noItemsAtAll);
    expect(await liveWindows(app)).toEqual([]);
  });

  it("16: a chargeback raises an owner review item, a refund does not", async () => {
    const app = await setup();
    await app.webhook(pass("txn_p", T));
    await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_p", action: "refund", customerId: "ctm_1" }));
    expect(app.notifier.reviews).toEqual([]);
    const cb = await setup();
    await cb.webhook(pass("txn_p", T));
    await cb.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_p", action: "chargeback", customerId: "ctm_1" }));
    expect(cb.notifier.reviews).toEqual([{ kind: "chargeback", accountId: "acc_test", transactionId: "txn_p" }]);
  });

  it("toPublicPlan reports a running complimentary window by its source, behind one constant", async () => {
    const app = await setup();
    const env = envFromDeps(app.t.deps);
    const out = await createGrantWindows(env, "acc_test", { grantId: "g", days: 10, startPolicy: "now" });
    expect(out.ok).toBe(true);
    const window = await app.stores.ledger.getCurrentWindow("acc_test", T + DAY);
    const view = toPublicPlan(await app.plan(), T + DAY, window);
    expect(view).toEqual({ id: COMPLIMENTARY_PLAN_ID, status: "active", period_start: "2026-11-01T09:30:00Z", period_end: "2026-11-11T09:30:00Z", cancel_at_period_end: false });
    expect(COMPLIMENTARY_PLAN_ID).toBe("free"); // until the public contract gains plus_complimentary
    // Without the window it is the free account it was.
    expect(toPublicPlan(await app.plan(), T + DAY, null)).toMatchObject({ id: "free", status: "none" });
    // A paid window wins over a grant window.
    await app.webhook(monthly(T + 20 * DAY));
    expect(toPublicPlan(await app.plan(), T + 21 * DAY, await app.stores.ledger.getCurrentWindow("acc_test", T + 21 * DAY))).toMatchObject({ id: "plus_monthly", status: "active" });
  });
});
