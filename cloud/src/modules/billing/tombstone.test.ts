// Account deletion removes the plan row and keeps only a tombstone with every Paddle id the account used. These
// tests play that: a fake account store where the plan is gone and only the tombstone holds the ids.

import { describe, expect, it } from "vitest";
import { TEST_START_MS } from "../../testing";
import { makeBillingTestApp, subscriptionEvent, transactionEvent, type BillingTestApp } from "../../testing/billing-test-app";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const DAY = 24 * 60 * 60 * 1000;

const monthly = (at: number, id = "sub_1") =>
  subscriptionEvent({ type: "subscription.created", subscriptionId: id, occurredAt: at, periodStart: at, periodEnd: addMonthsUTC(at, 1), customerId: "ctm_1" });
const runCron = (app: BillingTestApp) => app.t.app.scheduled({ scheduledTime: app.clock.now(), cron: "* * * * *" });

/**
 * An account with a subscription and a duplicate one (an extra cancellation), deleted: the tombstone has the ids, and
 * the account store then behaves as after #391's deletion: no plan row (and, with `rowGone`, no account row either),
 * `applyPlanEvent` and `savePlan` answer `not_found`, and nothing may write a plan.
 */
async function deleted(options: { rowGone?: boolean } = {}) {
  const app = makeBillingTestApp();
  await app.createAccount();
  await app.webhook(monthly(T));
  app.paddle.subscriptions.set("sub_1", { id: "sub_1", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
  app.paddle.subscriptions.set("sub_dup", { id: "sub_dup", status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
  app.paddle.failNext("cancelSubscription", "unavailable"); // the duplicate's first cancel fails, so it stays an extra cancellation
  await app.webhook(monthly(T + DAY, "sub_dup"));
  app.paddle.calls.length = 0;
  const tombstone = await app.stores.accounts.markDeleting("acc_test", T + 2 * DAY);
  expect([...tombstone!.paddleSubscriptionIds].sort()).toEqual(["sub_1", "sub_dup"]);

  const accounts = app.stores.accounts;
  // The plan row is gone after the deletion: nothing of it may schedule a retry any more (the tombstone does).
  const plan = (await accounts.getPlan("acc_test"))!;
  await accounts.savePlan({ ...plan, extraCancels: [], pendingCancel: null }, { expectedPlanVersion: (await accounts.getById("acc_test"))!.planVersion });
  const writes = { applyPlanEvent: 0, savePlan: 0 };
  const row = await accounts.getById("acc_test");
  accounts.getPlan = async () => null;
  if (options.rowGone) accounts.getById = async () => null;
  else accounts.getById = async () => row;
  accounts.applyPlanEvent = async () => (writes.applyPlanEvent++, { applied: false, reason: "not_found" });
  accounts.savePlan = async () => (writes.savePlan++, { ok: false, reason: "not_found" });
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
    app.paddle.failNext("cancelSubscription", "unavailable"); // the first id in the list fails (sub_1), the other succeeds
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    const t1 = (await app.stores.accounts.getTombstone("acc_test"))!;
    expect(t1.paddleSubscriptionIds.length).toBe(2); // the ids are retained
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
    expect((await app.stores.accounts.getTombstone("acc_test"))).toBeNull();
  });

  it("answers none for an account with neither a plan nor a tombstone", async () => {
    const app = makeBillingTestApp();
    expect(await app.billing.cancelSubscription("ghost", "now")).toEqual({ state: "none" });
  });
});

describe("a webhook for an account whose plan is gone", () => {
  for (const rowGone of [false, true]) {
    const label = rowGone ? "no account row and no plan row" : "an account row but no plan row";

    it(`only confirms a cancellation and never recreates plan state (${label})`, async () => {
      const { app, writes } = await deleted({ rowGone });
      app.paddle.failNext("cancelSubscription", "unavailable", 2); // both fail: both stay pending
      await app.billing.cancelSubscription("acc_test", "now");
      expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel!.pendingIds.sort()).toEqual(["sub_1", "sub_dup"]);

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
      // No plan was written by any of it, and no window exists for the dead account.
      expect(writes).toEqual({ applyPlanEvent: 0, savePlan: 0 });
      expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(1); // only the window from before the deletion
    });

    it(`quarantines a purchase, an update or a refund instead of applying it, and alerts for a payment (${label})`, async () => {
      const { app, writes } = await deleted({ rowGone });
      const windowsBefore = await app.stores.ledger.listWindows("acc_test");
      const purchase = transactionEvent({ transactionId: "txn_new", occurredAt: T + 3 * DAY, customerId: "ctm_1" });
      const update = subscriptionEvent({ subscriptionId: "sub_1", status: "past_due", occurredAt: T + 4 * DAY, customerId: "ctm_1" });
      for (const ev of [purchase, update]) {
        expect((await app.webhook(ev)).status).toBe(200);
        expect((await app.stores.webhookEvents.get((ev as any).event_id))!.state).toBe("quarantined");
      }
      expect(app.notifier.alerts.filter((a) => a.kind === "purchase_while_deleting")).toEqual([{ kind: "purchase_while_deleting", accountId: "acc_test" }]);
      expect(writes).toEqual({ applyPlanEvent: 0, savePlan: 0 });
      expect(await app.stores.ledger.listWindows("acc_test")).toEqual(windowsBefore);
    });
  }

  it("does not let checkout create a plan row for an account that is being deleted", async () => {
    const app = makeBillingTestApp();
    await app.createAccount(undefined, undefined, null);
    await app.stores.accounts.markDeleting("acc_test", T);
    const { ensureCustomerOnPlan } = await import("./plan-store");
    const { envFromDeps } = await import("./env");
    expect(await ensureCustomerOnPlan(envFromDeps(app.t.deps), "acc_test", "ctm_x")).toBeNull();
    expect(await app.stores.accounts.getPlan("acc_test")).toBeNull();
  });
});
