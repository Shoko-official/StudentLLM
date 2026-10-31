import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "../../storage";
import { TEST_START_MS } from "../../testing";
import { makeBillingTestApp, subscriptionEvent, transactionEvent, adjustmentEvent, type BillingTestApp } from "../../testing/billing-test-app";
import { chaosStores } from "../../testing/store-contract";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const END = addMonthsUTC(T, 1);

async function setup(options: Parameters<typeof makeBillingTestApp>[0] = {}): Promise<BillingTestApp> {
  const app = makeBillingTestApp(options);
  await app.createAccount();
  return app;
}

async function subscribed(options: Parameters<typeof makeBillingTestApp>[0] = {}): Promise<BillingTestApp> {
  const app = await setup(options);
  await app.webhook(subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_1", occurredAt: T, periodStart: T, periodEnd: END, customerId: "ctm_1" }));
  app.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: END, cancelScheduled: false });
  return app;
}

const runCron = (app: BillingTestApp) => app.t.app.scheduled({ scheduledTime: app.clock.now(), cron: "* * * * *" });

describe("BillingSeam.cancelSubscription", () => {
  it("is wired in deps for the deletion flow", async () => {
    const app = await setup();
    expect(typeof app.t.deps.billing.cancelSubscription).toBe("function");
    expect(await app.t.deps.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
  });

  it("period_end: Paddle schedules the cancel, the flag is set, the window runs to its end, the user is told", async () => {
    const app = await subscribed();
    const versionBefore = (await app.stores.accounts.getById("acc_test"))!.planVersion;
    app.clock.set(T + 3 * DAY);
    expect(await app.billing.cancelSubscription("acc_test", "period_end")).toEqual({ state: "cancelled" });
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "next_billing_period"]]);
    expect(await app.plan()).toMatchObject({ cancelAtPeriodEnd: true, status: "active", pendingCancel: null });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", END - 1)).toMatchObject({ end: END, revokedAt: null });
    expect(app.notifier.cancellations).toEqual([{ accountId: "acc_test", when: "period_end", effectiveAt: END }]);
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(versionBefore + 1); // clients refetch the account
    // Paddle then reports the same thing by webhook: a no-op (no second version, no change).
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 3 * DAY + 1000, scheduled: "cancel", periodStart: T, periodEnd: END, customerId: "ctm_1" }));
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(versionBefore + 1);
    // Repeating the call does not ask Paddle again.
    expect(await app.billing.cancelSubscription("acc_test", "period_end")).toEqual({ state: "cancelled" });
    expect(app.paddle.callsTo("cancelSubscription")).toHaveLength(1);
  });

  it("now: Paddle cancels at once and the running window ends at that instant, keeping the used credits", async () => {
    const app = await subscribed();
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 30, now: T + 1000, expiresAt: T + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 30, logicalModelId: "m", now: T + 2000 });
    const at = T + 9 * DAY;
    app.clock.set(at);
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "immediately"]]);
    expect(await app.plan()).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    expect(await app.stores.ledger.listWindows("acc_test")).toMatchObject([{ end: at, used: 30 }]);
    expect(await app.stores.ledger.getCurrentWindow("acc_test", at)).toBeNull();
    expect(app.notifier.cancellations).toEqual([{ accountId: "acc_test", when: "now", effectiveAt: at }]);
    // Paddle's own canceled event arrives afterwards and changes nothing.
    const version = (await app.stores.accounts.getById("acc_test"))!.planVersion;
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: at + 1000, customerId: "ctm_1" }));
    expect((await app.stores.accounts.getById("acc_test"))!.planVersion).toBe(version);
    expect(await app.stores.ledger.listWindows("acc_test")).toMatchObject([{ end: at, used: 30 }]);
  });

  it("answers none when there is nothing to cancel at Paddle", async () => {
    const free = await setup();
    expect(await free.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
    expect(await free.billing.cancelSubscription("ghost", "now")).toEqual({ state: "none" });

    const pass = await setup();
    await pass.webhook(transactionEvent({ transactionId: "txn_p", occurredAt: T, customerId: "ctm_1" }));
    expect(await pass.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });

    const ended = await subscribed();
    await ended.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: T + DAY, customerId: "ctm_1" }));
    expect(await ended.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
    expect(ended.paddle.callsTo("cancelSubscription")).toEqual([]);
    expect(ended.notifier.cancellations).toEqual([]);
  });

  it("answers pending when Paddle fails: visible on the plan, nothing else changes, retried by the scheduled task", async () => {
    const app = await subscribed();
    app.clock.set(T + DAY);
    app.paddle.failNext("cancelSubscription", "unavailable");
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    const retryAt = T + DAY + app.billing.settings.cancel.baseDelayMs;
    expect(await app.plan()).toMatchObject({ status: "active", pendingCancel: { when: "now", requestedAt: T + DAY, attempts: 1, nextAttemptAt: retryAt, alerted: false } });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).not.toBeNull(); // not cut before Paddle confirms
    expect(app.notifier.cancellations).toEqual([]);

    // Too early: the task leaves it alone.
    app.clock.set(retryAt - 1);
    await runCron(app);
    expect(app.paddle.callsTo("cancelSubscription")).toHaveLength(1);
    // Due: the task asks again, Paddle confirms, the pending state clears and the plan is updated.
    app.clock.set(retryAt);
    await runCron(app);
    expect(app.paddle.callsTo("cancelSubscription")).toHaveLength(2);
    expect(await app.plan()).toMatchObject({ status: "canceled", pendingCancel: null });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", retryAt)).toBeNull();
    expect(await app.stores.accounts.listPendingCancels(retryAt + DAY, 10)).toEqual([]);
  });

  it("backs off exponentially up to a cap and alerts the operator once, after repeated failures", async () => {
    const app = await subscribed();
    const { baseDelayMs, maxDelayMs, alertAfterAttempts } = app.billing.settings.cancel;
    app.paddle.failNext("cancelSubscription", "unavailable", 50);
    let now = T + DAY;
    app.clock.set(now);
    await app.billing.cancelSubscription("acc_test", "now");
    const delays: number[] = [];
    for (let attempt = 2; attempt <= alertAfterAttempts + 6; attempt++) {
      const pending = (await app.plan())!.pendingCancel!;
      delays.push(pending.nextAttemptAt - now);
      now = pending.nextAttemptAt;
      app.clock.set(now);
      await runCron(app);
    }
    const final = (await app.plan())!.pendingCancel!;
    expect(final.attempts).toBe(alertAfterAttempts + 6);
    expect(delays.slice(0, 3)).toEqual([baseDelayMs, baseDelayMs * 2, baseDelayMs * 4]);
    expect(Math.max(...delays, final.nextAttemptAt - now)).toBe(maxDelayMs);
    expect(app.notifier.alerts).toEqual([{ kind: "cancel_failing", accountId: "acc_test", attempts: alertAfterAttempts }]); // once
    expect(final.alerted).toBe(true);
  });

  it("treats Paddle's refusal of an already canceled or already scheduled subscription as success after a re-fetch", async () => {
    const canceled = await subscribed();
    canceled.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "canceled", customerId: "ctm_1", periodStart: T, periodEnd: END, cancelScheduled: false });
    canceled.clock.set(T + DAY);
    expect(await canceled.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(canceled.paddle.callsTo("getSubscription")).toEqual([["sub_1"]]);
    expect(await canceled.plan()).toMatchObject({ status: "canceled", pendingCancel: null });

    const scheduled = await subscribed();
    scheduled.paddle.failNext("cancelSubscription", "conflict");
    scheduled.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: END, cancelScheduled: true });
    expect(await scheduled.billing.cancelSubscription("acc_test", "period_end")).toEqual({ state: "cancelled" });

    // A refusal for a subscription that is neither canceled nor scheduled is a failure, not a success.
    const live = await subscribed();
    live.paddle.failNext("cancelSubscription", "conflict");
    expect(await live.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
  });

  it("keeps a stronger pending request when a weaker one fails later", async () => {
    const app = await subscribed();
    app.paddle.failNext("cancelSubscription", "unavailable", 2);
    await app.billing.cancelSubscription("acc_test", "now");
    await app.billing.cancelSubscription("acc_test", "period_end");
    expect((await app.plan())!.pendingCancel).toMatchObject({ when: "now", attempts: 2 });
  });

  it("does not drop the Paddle ids of a deleting account until a cancel succeeds (the tombstone rule)", async () => {
    const app = await subscribed();
    app.paddle.failNext("cancelSubscription", "unavailable", 2);
    await app.stores.accounts.markDeleting("acc_test", T + DAY);
    // The deletion flow calls the seam, sees pending and keeps the tombstone.
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    expect(await app.stores.accounts.getTombstone("acc_test")).toMatchObject({ paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1" });
    expect(await app.plan()).toMatchObject({ paddleSubscriptionId: "sub_1", pendingCancel: { attempts: 1 } });
    // Its own retry hits another failure, then the scheduled task and the next call succeed.
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    // No "your subscription ended" mail on top of the deletion mail.
    expect(app.notifier.cancellations).toEqual([]);
    // Calling again is safe (the deletion flow may retry): nothing left to cancel, so it may purge.
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
    expect(app.paddle.callsTo("cancelSubscription")).toHaveLength(3);
  });

  it("works from the tombstone when the plan row is gone", async () => {
    const app = await subscribed();
    await app.stores.accounts.markDeleting("acc_test", T + DAY);
    const tombstone = await app.stores.accounts.getTombstone("acc_test");
    expect(tombstone!.paddleSubscriptionId).toBe("sub_1");
    app.stores.accounts.getPlan = async () => null; // an adapter that dropped the plan row but kept the tombstone
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_1", "immediately"]]);
  });

  it("two parallel calls end in one consistent state, under reordering storage", async () => {
    const app = await subscribed({ stores: chaosStores(createInMemoryStores(), 3) });
    const results = await Promise.all([app.billing.cancelSubscription("acc_test", "period_end"), app.billing.cancelSubscription("acc_test", "period_end"), app.billing.cancelSubscription("acc_test", "period_end")]);
    for (const r of results) expect(["cancelled", "none"]).toContain(r.state);
    expect(await app.plan()).toMatchObject({ cancelAtPeriodEnd: true, status: "active", pendingCancel: null });
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1);
  });
});

describe("a cancellation requested because of a refund", () => {
  it("is attempted right after the webhook and retried by the scheduled task when Paddle is down", async () => {
    const app = await subscribed();
    await app.webhook(transactionEvent({ transactionId: "txn_1", subscriptionId: "sub_1", occurredAt: T + 1000, periodStart: T, periodEnd: END, customerId: "ctm_1" }));
    app.paddle.failNext("cancelSubscription", "unavailable");
    app.clock.set(T + DAY);
    const res = await app.webhook(adjustmentEvent({ occurredAt: T + DAY, transactionId: "txn_1", subscriptionId: "sub_1", customerId: "ctm_1" }));
    expect(res.status).toBe(200); // the webhook answers fast, whatever Paddle does
    expect(await app.plan()).toMatchObject({ status: "revoked", pendingCancel: { when: "now", attempts: 1 } });
    app.clock.advance(app.billing.settings.cancel.baseDelayMs);
    await runCron(app);
    expect(await app.plan()).toMatchObject({ status: "revoked", pendingCancel: null });
    expect(app.paddle.subscriptions.get("sub_1")!.status).toBe("canceled");
  });
});

describe("scheduled tasks", () => {
  it("prunes the webhook ledger past its retention, keeping recent events", async () => {
    const app = await setup();
    const old = subscriptionEvent({ type: "subscription.created", subscriptionId: "sub_1", occurredAt: T, periodStart: T, periodEnd: END, customerId: "ctm_1" });
    await app.webhook(old);
    app.clock.advance(app.billing.settings.webhookRetentionMs + DAY);
    const recent = subscriptionEvent({ subscriptionId: "sub_1", occurredAt: app.clock.now(), customerId: "ctm_1" });
    await app.webhook(recent);
    await runCron(app);
    expect(await app.stores.webhookEvents.get((old as any).event_id)).toBeNull();
    expect(await app.stores.webhookEvents.get((recent as any).event_id)).not.toBeNull();
  });

  it("a failing task does not stop the others", async () => {
    const app = await subscribed();
    app.stores.accounts.listPendingCancels = async () => {
      throw new Error("down");
    };
    app.clock.advance(app.billing.settings.webhookRetentionMs + DAY);
    await expect(runCron(app)).resolves.toBeUndefined();
  });

  it("names its tasks, so a failure can be logged without data", async () => {
    const app = await setup();
    const { createBillingScheduledTasks } = await import("./index");
    expect(createBillingScheduledTasks(app.t.deps).map((t) => t.name)).toEqual(["billing.retry-cancellations", "billing.prune-webhook-ledger"]);
  });
});
