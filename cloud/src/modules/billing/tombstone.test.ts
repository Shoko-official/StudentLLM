// Account deletion erases the account and plan rows at once and keeps only a tombstone with the Paddle ids the
// account used (#391). These tests play that against the real in-memory store: the plan is gone, only the tombstone
// holds the ids, and a spy proves that nothing here writes plan state.

import { describe, expect, it } from "vitest";
import { TEST_START_MS } from "../../testing";
import { makeBillingTestApp, subscriptionEvent, transactionEvent, type BillingTestApp } from "../../testing/billing-test-app";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const DAY = 24 * 60 * 60 * 1000;

const monthly = (at: number, id = "sub_1", extra: Record<string, unknown> = {}) =>
  subscriptionEvent({ type: "subscription.created", subscriptionId: id, occurredAt: at, periodStart: at, periodEnd: addMonthsUTC(at, 1), customerId: "ctm_1", ...extra });
const runCron = (app: BillingTestApp) => app.t.app.scheduled({ scheduledTime: app.clock.now(), cron: "* * * * *" });

/**
 * An account with a subscription and a duplicate one (an extra cancellation), then deleted. Returns the app and a
 * counter of the plan writes that happen after the deletion (there must be none).
 */
async function deleted() {
  const app = makeBillingTestApp();
  await app.createAccount();
  await app.webhook(monthly(T));
  app.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
  app.paddle.subscriptions.set("sub_dup", { id: "sub_dup", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
  app.paddle.failNext("cancelSubscription", "unavailable"); // the duplicate's first cancel fails, so it stays an extra cancellation
  await app.webhook(monthly(T + DAY, "sub_dup"));
  app.paddle.calls.length = 0;
  const tombstone = await app.stores.accounts.markDeleting("acc_test", T + 2 * DAY);
  expect([...tombstone!.paddleSubscriptionIds!].sort()).toEqual(["sub_1", "sub_dup"]);
  expect(await app.stores.accounts.getById("acc_test")).toBeNull(); // erased at tombstone creation
  expect(await app.stores.accounts.getPlan("acc_test")).toBeNull();

  const accounts = app.stores.accounts;
  const writes = { applyPlanEvent: 0, savePlan: 0 };
  const applyPlanEvent = accounts.applyPlanEvent.bind(accounts);
  const savePlan = accounts.savePlan.bind(accounts);
  accounts.applyPlanEvent = async (...args) => (writes.applyPlanEvent++, applyPlanEvent(...args));
  accounts.savePlan = async (...args) => (writes.savePlan++, savePlan(...args));
  return { app, writes };
}

describe("cancelling when the plan row is gone and only the tombstone holds the ids", () => {
  it("cancels every subscription the tombstone lists, including the one that was an extra cancellation", async () => {
    const { app } = await deleted();
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(app.paddle.callsTo("cancelSubscription").map((c) => c[0]).sort()).toEqual(["sub_1", "sub_dup"]);
    expect(app.paddle.callsTo("cancelSubscription").every((c) => c[1] === "immediately")).toBe(true);
    expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel).toMatchObject({ state: "done", pendingIds: [] });
    // Repeating it (the deletion flow may retry) is safe and asks Paddle for nothing.
    app.paddle.calls.length = 0;
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([]);
  });

  it("keeps the retry on the tombstone until every cancel succeeded, retrying only the ones still pending", async () => {
    const { app } = await deleted();
    app.paddle.failNext("cancelSubscription", "unavailable"); // the first id in the list fails, the other succeeds
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    const t1 = (await app.stores.accounts.getTombstone("acc_test"))!;
    expect(t1.paddleSubscriptionIds).toHaveLength(2); // the ids are retained
    expect(t1.cancel).toMatchObject({ state: "pending", attempts: 1 });
    expect(t1.cancel!.pendingIds).toHaveLength(1);
    const stillPending = t1.cancel!.pendingIds[0]!;

    // Not due yet: the scheduled task does nothing. Due: it retries only the pending id.
    app.paddle.calls.length = 0;
    app.clock.set(t1.cancel!.nextAttemptAt - 1);
    await runCron(app);
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([]);
    app.paddle.failNext("cancelSubscription", "unavailable"); // fails again
    app.clock.set(t1.cancel!.nextAttemptAt);
    await runCron(app);
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([[stillPending, "immediately"]]);
    const t2 = (await app.stores.accounts.getTombstone("acc_test"))!;
    expect(t2.cancel).toMatchObject({ state: "pending", attempts: 2, pendingIds: [stillPending] });
    expect(t2.cancel!.nextAttemptAt - app.clock.now()).toBe(app.billing.settings.cancel.baseDelayMs * 2); // backoff grows

    // Paddle recovers: the task finishes it and the retry stops.
    app.clock.set(t2.cancel!.nextAttemptAt);
    await runCron(app);
    expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel).toMatchObject({ state: "done", pendingIds: [] });
    expect(await app.stores.accounts.listPendingCancels(app.clock.now() + 365 * DAY, 10)).toEqual([]);
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
  });

  it("alerts the operator once after repeated failures, with the subscription id", async () => {
    const { app } = await deleted();
    app.paddle.failNext("cancelSubscription", "unavailable", 100);
    await app.billing.cancelSubscription("acc_test", "now");
    for (let i = 1; i < app.billing.settings.cancel.alertAfterAttempts + 3; i++) {
      app.clock.set((await app.stores.accounts.getTombstone("acc_test"))!.cancel!.nextAttemptAt);
      await runCron(app);
    }
    const alerts = app.notifier.alerts.filter((a) => a.kind === "cancel_failing");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ accountId: "acc_test", attempts: app.billing.settings.cancel.alertAfterAttempts });
    expect((alerts[0] as { subscriptionId: string }).subscriptionId).toMatch(/^sub_/);
  });

  it("resolves the ids from the plan when the plan still exists (the account that is not deleted)", async () => {
    const app = makeBillingTestApp();
    await app.createAccount();
    await app.webhook(monthly(T));
    app.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(await app.stores.accounts.getTombstone("acc_test")).toBeNull();
  });

  it("answers none for an account with neither a plan nor a tombstone, and for a tombstone with nothing to cancel", async () => {
    const app = makeBillingTestApp();
    expect(await app.billing.cancelSubscription("ghost", "now")).toEqual({ state: "none" });
    await app.createAccount(undefined, undefined, null);
    await app.stores.accounts.markDeleting("acc_test", T);
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" });
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([]);
  });
});

describe("a webhook for a deleted account", () => {
  it("only confirms a cancellation and never recreates plan state", async () => {
    const { app, writes } = await deleted();
    app.paddle.failNext("cancelSubscription", "unavailable", 2); // both fail: both stay pending
    await app.billing.cancelSubscription("acc_test", "now");
    expect([...(await app.stores.accounts.getTombstone("acc_test"))!.cancel!.pendingIds].sort()).toEqual(["sub_1", "sub_dup"]);

    const res = await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_dup", status: "canceled", occurredAt: T + 3 * DAY, customerId: "ctm_1" }));
    expect(res.status).toBe(200);
    expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_1"] });
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_1", status: "canceled", occurredAt: T + 3 * DAY + 1000, customerId: "ctm_1" }));
    expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel).toMatchObject({ state: "done", pendingIds: [] });

    // The retry has nothing left to do.
    app.paddle.calls.length = 0;
    app.clock.advance(app.billing.settings.cancel.maxDelayMs);
    await runCron(app);
    expect(app.paddle.callsTo("cancelSubscription")).toEqual([]);
    // No plan was written by any of it, and none exists.
    expect(writes).toEqual({ applyPlanEvent: 0, savePlan: 0 });
    expect(await app.stores.accounts.getPlan("acc_test")).toBeNull();
  });

  it("quarantines an update or a refund instead of applying it", async () => {
    const { app, writes } = await deleted();
    const windowsBefore = await app.stores.ledger.listWindows("acc_test");
    const update = subscriptionEvent({ subscriptionId: "sub_1", status: "past_due", occurredAt: T + 4 * DAY, customerId: "ctm_1" });
    expect((await app.webhook(update)).status).toBe(200);
    expect((await app.stores.webhookEvents.get((update as any).event_id))!.state).toBe("quarantined");
    expect(writes).toEqual({ applyPlanEvent: 0, savePlan: 0 });
    expect(await app.stores.ledger.listWindows("acc_test")).toEqual(windowsBefore);
    expect(await app.stores.accounts.getPlan("acc_test")).toBeNull();
  });

  describe("a subscription paid for during the deletion", () => {
    it("is canceled at Paddle and appended to the tombstone, found through its customer id", async () => {
      const { app, writes } = await deleted();
      await app.billing.cancelSubscription("acc_test", "now"); // the deletion's own cancel is done
      expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel).toMatchObject({ state: "done" });
      app.paddle.calls.length = 0;
      app.paddle.subscriptions.set("sub_late", { id: "sub_late", status: "active", customerId: "ctm_1", periodStart: T + 3 * DAY, periodEnd: addMonthsUTC(T + 3 * DAY, 1), cancelScheduled: false });

      const ev = monthly(T + 3 * DAY, "sub_late"); // a checkout opened before the deletion, paid during it
      expect((await app.webhook(ev)).status).toBe(200);
      expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_late", "immediately"]]);
      const tombstone = (await app.stores.accounts.getTombstone("acc_test"))!;
      expect(tombstone.paddleSubscriptionIds).toContain("sub_late");
      expect(tombstone.cancel).toMatchObject({ state: "done", pendingIds: [] });
      // The event is quarantined for the operator (the customer paid: a refund), with the ids in the alert.
      expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
      expect(app.notifier.alerts).toContainEqual({ kind: "webhook_quarantined", eventId: (ev as any).event_id, reason: "account_deleted", subscriptionId: "sub_late", customerId: "ctm_1" });
      expect(writes).toEqual({ applyPlanEvent: 0, savePlan: 0 });
      // Its later events resolve to the tombstone too, and its cancellation confirmation is recorded.
      expect(await app.stores.accounts.findAccountIdByPaddleSubscription("sub_late")).toBe("acc_test");
    });

    it("keeps retrying when Paddle is down, with the new id on the tombstone's pending list", async () => {
      const { app } = await deleted();
      await app.billing.cancelSubscription("acc_test", "now");
      app.paddle.calls.length = 0;
      app.paddle.failNext("cancelSubscription", "unavailable");
      await app.webhook(monthly(T + 3 * DAY, "sub_late"));
      const t = (await app.stores.accounts.getTombstone("acc_test"))!;
      expect(t.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_late"], attempts: 1 });
      expect(await app.stores.accounts.listPendingCancels(t.cancel!.nextAttemptAt, 10)).toEqual(["acc_test"]);
      app.clock.set(t.cancel!.nextAttemptAt);
      app.paddle.subscriptions.set("sub_late", { id: "sub_late", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: T + 30 * DAY, cancelScheduled: false });
      await runCron(app);
      // The scheduled run also includes the account module's deletion retry: it saw the cancel through the seam and purged the tombstone.
      const after = await app.stores.accounts.getTombstone("acc_test");
      expect(after === null || after.cancel?.state === "done").toBe(true);
      expect(app.paddle.callsTo("cancelSubscription").length).toBeGreaterThanOrEqual(2);
      expect(new Set(app.paddle.callsTo("cancelSubscription").map((c) => c[0]))).toEqual(new Set(["sub_late"]));
    });

    it("is found through custom_data when it carries a customer id the account never had", async () => {
      const { app } = await deleted();
      await app.billing.cancelSubscription("acc_test", "now");
      app.paddle.calls.length = 0;
      await app.webhook(monthly(T + 3 * DAY, "sub_late", { customerId: "ctm_new", accountId: "acc_test" }));
      expect(app.paddle.callsTo("cancelSubscription")).toEqual([["sub_late", "immediately"]]);
      const tombstone = (await app.stores.accounts.getTombstone("acc_test"))!;
      expect(tombstone.paddleSubscriptionIds).toContain("sub_late");
      expect(tombstone.paddleCustomerIds).toContain("ctm_new");
      expect(await app.stores.accounts.findAccountIdByPaddleCustomer("ctm_new")).toBe("acc_test");
    });

    it("a one-time pass paid during the deletion has no subscription to cancel: quarantined, the operator is told", async () => {
      const { app } = await deleted();
      await app.billing.cancelSubscription("acc_test", "now");
      app.paddle.calls.length = 0;
      const ev = transactionEvent({ transactionId: "txn_pass", occurredAt: T + 3 * DAY, customerId: "ctm_1" });
      await app.webhook(ev);
      expect(app.paddle.callsTo("cancelSubscription")).toEqual([]);
      expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
      expect(app.notifier.alerts).toContainEqual({ kind: "purchase_while_deleting", accountId: "acc_test" });
      expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1); // only the window from before the deletion
    });

    it("a payment for an account that was already purged resolves to nothing: quarantined as unknown", async () => {
      const { app } = await deleted();
      await app.stores.accounts.purgeAccount("acc_test");
      const ev = monthly(T + 3 * DAY, "sub_late");
      await app.webhook(ev);
      expect((await app.stores.webhookEvents.get((ev as any).event_id))!).toMatchObject({ state: "quarantined" });
      expect(app.notifier.alerts).toContainEqual(expect.objectContaining({ reason: "unknown_account", subscriptionId: "sub_late" }));
    });
  });

  it("does not let checkout create a plan row for a deleted account", async () => {
    const app = makeBillingTestApp();
    await app.createAccount(undefined, undefined, null);
    await app.stores.accounts.markDeleting("acc_test", T);
    const { ensureCustomerOnPlan } = await import("./plan-store");
    const { envFromDeps } = await import("./env");
    expect(await ensureCustomerOnPlan(envFromDeps(app.t.deps), "acc_test", "ctm_x")).toBeNull();
    expect(await app.stores.accounts.getPlan("acc_test")).toBeNull();
  });
});
