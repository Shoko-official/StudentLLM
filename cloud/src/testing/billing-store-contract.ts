// Test-only: the billing part of the store behavior, as a reusable suite next to `runStoreContract`
// (the shared suite stays untouched). The Durable Object / D1 adapters run it against their own factory:
//
//   runBillingStoreContract("in-memory", () => createInMemoryStores());
//   runBillingStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores()));

import { describe, expect, it } from "vitest";
import type { PlanRecord } from "../storage";
import type { StoreFactory } from "./store-contract";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

export function runBillingStoreContract(label: string, factory: StoreFactory): void {
  async function accountWith(id = "acc_1") {
    const stores = factory();
    const r = await stores.accounts.create({ accountId: id, email: `${id}@example.invalid`, googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 });
    if (!r.ok) throw new Error("setup failed");
    return stores;
  }

  const plan = (over: Partial<PlanRecord> = {}): PlanRecord => ({
    accountId: "acc_1",
    planId: "plus_monthly",
    status: "active",
    paidPeriods: [{ start: T0, end: T0 + 30 * DAY, kind: "subscription", purchaseId: "txn_1" }],
    cancelAtPeriodEnd: false,
    paddleCustomerId: "ctm_1",
    paddleSubscriptionId: "sub_1",
    lastEventAt: null,
    ...over,
  });

  describe(`${label}: billing, AccountStore plan part`, () => {
    it("keeps the plan version when an event produces the same plan, and moves it when the plan changes", async () => {
      const stores = await accountWith();
      const first = await stores.accounts.applyPlanEvent("acc_1", T0 + 1, () => plan());
      expect(first).toMatchObject({ applied: true, changed: true, planVersion: 1 });
      // The same facts again (a duplicate delivery under another event id): recorded, but nothing changed.
      const same = await stores.accounts.applyPlanEvent("acc_1", T0 + 2, (cur) => ({ ...cur!, pendingCancel: null }));
      expect(same).toMatchObject({ applied: true, changed: false, planVersion: 1 });
      expect((await stores.accounts.getPlan("acc_1"))!.lastEventAt).toBe(T0 + 2); // still ordered by the newest event
      const changed = await stores.accounts.applyPlanEvent("acc_1", T0 + 3, (cur) => ({ ...cur!, status: "past_due" }));
      expect(changed).toMatchObject({ applied: true, changed: true, planVersion: 2 });
      expect((await stores.accounts.getById("acc_1"))!.planVersion).toBe(2);
      // A stale event still changes nothing, whatever its content.
      expect(await stores.accounts.applyPlanEvent("acc_1", T0 + 1, (cur) => ({ ...cur!, status: "active" }))).toEqual({ applied: false, reason: "stale" });
    });

    it("round-trips the period details and the pending cancellation as copies", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () =>
        plan({
          paidPeriods: [{ start: T0, end: T0 + DAY, kind: "pass", purchaseId: "txn_9", revokedAt: T0 + 5 }],
          pendingCancel: { when: "now", requestedAt: T0, attempts: 1, nextAttemptAt: T0 + 100, alerted: false },
        }),
      );
      const read = (await stores.accounts.getPlan("acc_1"))!;
      expect(read.paidPeriods[0]).toEqual({ start: T0, end: T0 + DAY, kind: "pass", purchaseId: "txn_9", revokedAt: T0 + 5 });
      read.paidPeriods[0]!.kind = "subscription";
      read.pendingCancel!.attempts = 99;
      const again = (await stores.accounts.getPlan("acc_1"))!;
      expect(again.paidPeriods[0]!.kind).toBe("pass");
      expect(again.pendingCancel!.attempts).toBe(1);
    });

    it("lists the accounts whose pending cancellation is due, earliest first, and not the others", async () => {
      const stores = await accountWith("acc_1");
      for (const id of ["acc_2", "acc_3", "acc_4"]) {
        await stores.accounts.create({ accountId: id, email: `${id}@example.invalid`, googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 });
      }
      const pending = (at: number) => ({ when: "now" as const, requestedAt: T0, attempts: 1, nextAttemptAt: at, alerted: false });
      await stores.accounts.applyPlanEvent("acc_1", T0, () => plan({ pendingCancel: pending(T0 + 300) }));
      await stores.accounts.applyPlanEvent("acc_2", T0, () => plan({ accountId: "acc_2", paddleCustomerId: "ctm_2", paddleSubscriptionId: "sub_2", pendingCancel: pending(T0 + 100) }));
      await stores.accounts.applyPlanEvent("acc_3", T0, () => plan({ accountId: "acc_3", paddleCustomerId: "ctm_3", paddleSubscriptionId: "sub_3", pendingCancel: null }));
      await stores.accounts.applyPlanEvent("acc_4", T0, () => plan({ accountId: "acc_4", paddleCustomerId: "ctm_4", paddleSubscriptionId: "sub_4", pendingCancel: pending(T0 + 10_000) }));
      expect(await stores.accounts.listPendingCancels(T0 + 50, 10)).toEqual([]);
      expect(await stores.accounts.listPendingCancels(T0 + 400, 10)).toEqual(["acc_2", "acc_1"]);
      expect(await stores.accounts.listPendingCancels(T0 + 400, 1)).toEqual(["acc_2"]);
    });

    /** A deleted account with two subscriptions (sub_1 current, sub_2 recorded by billing). */
    async function deletedWithTwo() {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () => plan({ extraCancels: [{ subscriptionId: "sub_2", customerId: null, reason: "duplicate", requestedAt: T0, attempts: 0, nextAttemptAt: T0, alerted: false }] }));
      await stores.accounts.markDeleting("acc_1", T0 + 1);
      return stores;
    }

    it("keeps the Paddle ids in the tombstone and schedules the retry from the tombstone once a cancel attempt failed", async () => {
      const stores = await deletedWithTwo();
      const t = (await stores.accounts.getTombstone("acc_1"))!;
      expect(t).toMatchObject({ paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1" });
      expect([...t.paddleSubscriptionIds!].sort()).toEqual(["sub_1", "sub_2"]);
      // The deletion erased the plan, and with it the plan\'s own pending cancel: only the tombstone can schedule now.
      expect(await stores.accounts.listPendingCancels(T0 + 1, 10)).toEqual([]);
      const r = await stores.accounts.updateTombstoneCancel("acc_1", { now: T0 + 2, confirmed: ["sub_1"], failedAttempt: { nextAttemptAt: T0 + 100, alertAfter: 5 } });
      expect(r!.tombstone.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_2"], confirmedIds: ["sub_1"], attempts: 1, nextAttemptAt: T0 + 100, alerted: false });
      expect(await stores.accounts.listPendingCancels(T0 + 99, 10)).toEqual([]);
      expect(await stores.accounts.listPendingCancels(T0 + 100, 10)).toEqual(["acc_1"]);
      const done = await stores.accounts.updateTombstoneCancel("acc_1", { now: T0 + 101, confirmed: ["sub_2"] });
      expect(done!.tombstone.cancel).toMatchObject({ state: "done", pendingIds: [], confirmedIds: ["sub_1", "sub_2"] });
      expect(await stores.accounts.listPendingCancels(T0 + 1000, 10)).toEqual([]);
      expect(await stores.accounts.updateTombstoneCancel("ghost", { now: T0 })).toBeNull();
    });

    it("creates the cancel state with EVERY tombstone id pending, and is done only when every id is confirmed", async () => {
      const stores = await deletedWithTwo();
      const first = await stores.accounts.updateTombstoneCancel("acc_1", { now: T0 + 2, confirmed: ["sub_2"] }); // a confirmation before any attempt
      expect(first!.tombstone.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_1"], confirmedIds: ["sub_2"] });
      // An id that is not the tombstone\'s confirms nothing and cannot complete the job.
      const stray = await stores.accounts.updateTombstoneCancel("acc_1", { now: T0 + 3, confirmed: ["sub_unrelated"] });
      expect(stray!.tombstone.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_1"] });
    });

    it("applies updates additively: a late update cannot erase what a concurrent one recorded", async () => {
      const stores = await deletedWithTwo();
      await stores.accounts.addTombstoneSubscription("acc_1", "sub_stray", null, T0 + 2);
      // The slow attempt only knows about sub_1 and sub_2; it must not mark the stray confirmed or the job done.
      const r = await stores.accounts.updateTombstoneCancel("acc_1", { now: T0 + 3, confirmed: ["sub_1", "sub_2"] });
      expect(r!.tombstone.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_stray"] });
      // Parallel updates all land: each confirmation is kept.
      const s2 = await deletedWithTwo();
      await Promise.all([
        s2.accounts.updateTombstoneCancel("acc_1", { now: T0 + 2, confirmed: ["sub_1"] }),
        s2.accounts.updateTombstoneCancel("acc_1", { now: T0 + 2, confirmed: ["sub_2"] }),
        s2.accounts.addTombstoneSubscription("acc_1", "sub_stray", null, T0 + 2),
      ]);
      const t = (await s2.accounts.getTombstone("acc_1"))!;
      expect(t.cancel!.confirmedIds.slice().sort()).toEqual(["sub_1", "sub_2"]);
      expect(t.cancel!.pendingIds).toEqual(["sub_stray"]);
      expect(t.cancel!.state).toBe("pending");
    });

    it("counts failed attempts, reports the alert threshold once, and a new id re-opens a finished cancel", async () => {
      const stores = await deletedWithTwo();
      const fail = (now: number) => stores.accounts.updateTombstoneCancel("acc_1", { now, failedAttempt: { nextAttemptAt: now + 10, alertAfter: 2 } });
      expect((await fail(T0 + 2))!.newlyAlerted).toBe(false);
      expect((await fail(T0 + 3))!.newlyAlerted).toBe(true);
      const third = await fail(T0 + 4);
      expect(third!.newlyAlerted).toBe(false);
      expect(third!.tombstone.cancel).toMatchObject({ attempts: 3, alerted: true });
      await stores.accounts.updateTombstoneCancel("acc_1", { now: T0 + 5, confirmed: ["sub_1", "sub_2"] });
      expect((await stores.accounts.getTombstone("acc_1"))!.cancel).toMatchObject({ state: "done" });
      const reopened = await stores.accounts.addTombstoneSubscription("acc_1", "sub_late", "ctm_late", T0 + 50);
      expect(reopened!.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_late"], attempts: 0, alerted: false, nextAttemptAt: T0 + 50 });
    });

    it("appends a subscription that appears after the deletion to the tombstone and the indexes, once", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () => plan());
      await stores.accounts.markDeleting("acc_1", T0 + 1);
      const t = await stores.accounts.addTombstoneSubscription("acc_1", "sub_late", "ctm_late", T0 + 2);
      expect([...t!.paddleSubscriptionIds!].sort()).toEqual(["sub_1", "sub_late"]);
      expect([...t!.paddleCustomerIds!].sort()).toEqual(["ctm_1", "ctm_late"]);
      await stores.accounts.addTombstoneSubscription("acc_1", "sub_late", "ctm_late", T0 + 3);
      expect((await stores.accounts.getTombstone("acc_1"))!.paddleSubscriptionIds).toHaveLength(2);
      expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_late")).toBe("acc_1");
      expect(await stores.accounts.findAccountIdByPaddleCustomer("ctm_late")).toBe("acc_1");
      expect(await stores.accounts.addTombstoneSubscription("ghost", "sub_x", null, T0)).toBeNull();
    });

    it("resolves a payment to its account, and keeps resolving the ids an account used after its plan moved on", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () => plan({ revokedPurchaseIds: ["txn_refunded"] }));
      expect(await stores.accounts.findAccountIdByPurchase("txn_1")).toBe("acc_1"); // the purchase of a period
      expect(await stores.accounts.findAccountIdByPurchase("txn_refunded")).toBe("acc_1"); // a refunded payment is remembered
      expect(await stores.accounts.findAccountIdByPurchase("txn_nope")).toBeNull();
      await stores.accounts.applyPlanEvent("acc_1", T0 + 1, (cur) => ({
        ...cur!,
        paddleCustomerId: "ctm_2",
        retiredCustomerIds: ["ctm_1"],
        paddleSubscriptionId: "sub_2",
        retiredSubscriptionIds: ["sub_1"],
        extraCancels: [{ subscriptionId: "sub_dup", customerId: "ctm_1", reason: "duplicate", requestedAt: T0, attempts: 0, nextAttemptAt: T0, alerted: false }],
      }));
      for (const id of ["ctm_1", "ctm_2"]) expect(await stores.accounts.findAccountIdByPaddleCustomer(id), id).toBe("acc_1");
      for (const id of ["sub_1", "sub_2", "sub_dup"]) expect(await stores.accounts.findAccountIdByPaddleSubscription(id), id).toBe("acc_1");
      await stores.accounts.purgeAccount("acc_1");
      for (const id of ["ctm_1", "ctm_2"]) expect(await stores.accounts.findAccountIdByPaddleCustomer(id)).toBeNull();
      expect(await stores.accounts.findAccountIdByPurchase("txn_1")).toBeNull();
      expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_dup")).toBeNull();
    });

    it("never gives an id to a second account", async () => {
      const stores = await accountWith("acc_1");
      await stores.accounts.create({ accountId: "acc_2", email: "b@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 });
      await stores.accounts.applyPlanEvent("acc_1", T0, () => plan());
      await stores.accounts.applyPlanEvent("acc_2", T0, () => plan({ accountId: "acc_2" }));
      expect(await stores.accounts.findAccountIdByPaddleCustomer("ctm_1")).toBe("acc_1");
      expect(await stores.accounts.findAccountIdByPurchase("txn_1")).toBe("acc_1");
    });

    it("keeps every subscription and customer id in the deletion tombstone", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () =>
        plan({
          retiredSubscriptionIds: ["sub_old"],
          retiredCustomerIds: ["ctm_old"],
          extraCancels: [{ subscriptionId: "sub_dup", customerId: null, reason: "duplicate", requestedAt: T0, attempts: 1, nextAttemptAt: T0 + 10, alerted: false }],
        }),
      );
      const t = await stores.accounts.markDeleting("acc_1", T0 + 1);
      expect([...t!.paddleSubscriptionIds!].sort()).toEqual(["sub_1", "sub_dup", "sub_old"]);
      expect([...t!.paddleCustomerIds!].sort()).toEqual(["ctm_1", "ctm_old"]);
      // A plan with a single id leaves the optional lists out: the tombstone keeps the shape of the account module.
      const plain = await accountWith("acc_2");
      await plain.accounts.applyPlanEvent("acc_2", T0, () => plan({ accountId: "acc_2" }));
      const t2 = await plain.accounts.markDeleting("acc_2", T0 + 1);
      expect(t2).toEqual({ accountId: "acc_2", paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1", createdAt: T0 + 1 });
    });

    it("lists an account whose only waiting cancellation is an extra one, when it is due", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () =>
        plan({ extraCancels: [{ subscriptionId: "sub_dup", customerId: null, reason: "duplicate", requestedAt: T0, attempts: 1, nextAttemptAt: T0 + 100, alerted: false }] }),
      );
      expect(await stores.accounts.listPendingCancels(T0 + 99, 10)).toEqual([]);
      expect(await stores.accounts.listPendingCancels(T0 + 100, 10)).toEqual(["acc_1"]);
    });
  });

  describe(`${label}: billing, WebhookEventStore replay`, () => {
    it("moves a quarantined event to processed once, and only a quarantined one", async () => {
      const { webhookEvents } = factory();
      const ev = { eventId: "evt_q", eventType: "adjustment.updated", occurredAt: T0 };
      const c = await webhookEvents.claim(ev, T0, 60_000);
      expect(await webhookEvents.markReplayed("evt_q", T0 + 1)).toBe(false); // still processing
      await webhookEvents.complete("evt_q", c.record.attempt, "quarantined", { transaction_id: "txn_1", action: "chargeback", adjustment_type: "full" }, T0 + 2);
      expect((await webhookEvents.listQuarantined()).map((e) => e.eventId)).toEqual(["evt_q"]);
      expect(await webhookEvents.markReplayed("evt_q", T0 + 3)).toBe(true);
      expect(await webhookEvents.markReplayed("evt_q", T0 + 4)).toBe(false);
      expect(await webhookEvents.listQuarantined()).toEqual([]);
      expect((await webhookEvents.claim(ev, T0 + 5, 60_000)).outcome).toBe("duplicate");
      expect(await webhookEvents.markReplayed("evt_ghost", T0)).toBe(false);
    });
  });

  describe(`${label}: billing, quarantine lookup by transaction`, () => {
    it("finds quarantined events by the transaction they name, and forgets them once replayed or pruned", async () => {
      const { webhookEvents } = factory();
      const quarantine = async (eventId: string, fields: Record<string, string>, at = T0) => {
        const c = await webhookEvents.claim({ eventId, eventType: "adjustment.updated", occurredAt: at }, at, 60_000);
        await webhookEvents.complete(eventId, c.record.attempt, "quarantined", fields, at + 1);
      };
      await quarantine("evt_a", { transaction_id: "txn_1", action: "chargeback" });
      await quarantine("evt_b", { transaction_id: "txn_2" });
      await quarantine("evt_c", { transaction_id: "txn_1" });
      await quarantine("evt_d", { customer_id: "ctm_1" }); // names no transaction: never found by one
      expect((await webhookEvents.findQuarantinedByTransaction(["txn_1"])).map((e) => e.eventId).sort()).toEqual(["evt_a", "evt_c"]);
      expect((await webhookEvents.findQuarantinedByTransaction(["txn_1", "txn_2", "txn_1"])).map((e) => e.eventId).sort()).toEqual(["evt_a", "evt_b", "evt_c"]);
      expect(await webhookEvents.findQuarantinedByTransaction(["txn_none"])).toEqual([]);
      expect(await webhookEvents.findQuarantinedByTransaction([])).toEqual([]);
      await webhookEvents.markReplayed("evt_a", T0 + 5);
      expect((await webhookEvents.findQuarantinedByTransaction(["txn_1"])).map((e) => e.eventId)).toEqual(["evt_c"]);
      await webhookEvents.deleteOlderThan(T0 + 100);
      expect(await webhookEvents.findQuarantinedByTransaction(["txn_1", "txn_2"])).toEqual([]);
    });

    it("does not offer a processed event", async () => {
      const { webhookEvents } = factory();
      const c = await webhookEvents.claim({ eventId: "evt_p", eventType: "adjustment.updated", occurredAt: T0 }, T0, 60_000);
      await webhookEvents.complete("evt_p", c.record.attempt, "processed", { transaction_id: "txn_9" }, T0);
      expect(await webhookEvents.findQuarantinedByTransaction(["txn_9"])).toEqual([]);
    });
  });

  describe(`${label}: billing, plan version touch`, () => {
    it("bumps the plan version without changing the plan or its event ordering", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0 + 1, () => plan());
      const before = await stores.accounts.getPlan("acc_1");
      expect(await stores.accounts.touchPlanVersion("acc_1")).toBe(2);
      expect(await stores.accounts.touchPlanVersion("acc_1")).toBe(3);
      expect(await stores.accounts.getPlan("acc_1")).toEqual(before);
      expect((await stores.accounts.getById("acc_1"))!.planVersion).toBe(3);
      expect(await stores.accounts.touchPlanVersion("ghost")).toBeNull();
      // Parallel touches each count once.
      await Promise.all(Array.from({ length: 5 }, () => stores.accounts.touchPlanVersion("acc_1")));
      expect((await stores.accounts.getById("acc_1"))!.planVersion).toBe(8);
      // An account that never had a plan can be touched too.
      const fresh = await accountWith("acc_2");
      expect(await fresh.accounts.touchPlanVersion("acc_2")).toBe(1);
    });
  });

  describe(`${label}: billing, LedgerStore window provisioning`, () => {
    const w = { start: T0, end: T0 + 30 * DAY, limit: 100 };

    it("defaults to a Paddle window and records the source and grant of a complimentary one", async () => {
      const { ledger } = factory();
      expect(await ledger.ensureWindow("a", w)).toMatchObject({ source: "paddle", grantId: null, revokedAt: null });
      const g = await ledger.ensureWindow("a", { start: T0 + 30 * DAY, end: T0 + 60 * DAY, limit: 50, source: "admin_grant", grantId: "grt_1" });
      expect(g).toMatchObject({ source: "admin_grant", grantId: "grt_1", limit: 50 });
    });

    it("ensures a window idempotently: parallel calls make one window, and the limit and source never change", async () => {
      const { ledger } = factory();
      const all = await Promise.all(Array.from({ length: 6 }, () => ledger.ensureWindow("a", w)));
      expect(all.every((x) => x.start === w.start)).toBe(true);
      expect(await ledger.listWindows("a")).toHaveLength(1);
      const again = await ledger.ensureWindow("a", { ...w, limit: 9999, source: "admin_grant", grantId: "x" });
      expect(again).toMatchObject({ limit: 100, source: "paddle", grantId: null });
    });

    it("never un-revokes a window: replaying a purchase after a refund buys nothing", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", w);
      expect(await ledger.revokeWindows("a", T0 + DAY)).toBe(1);
      expect((await ledger.ensureWindow("a", w)).revokedAt).toBe(T0 + DAY);
      expect(await ledger.getCurrentWindow("a", T0 + 2 * DAY)).toBeNull();
    });

    it("revokes only the windows of the given source or grant", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", w);
      await ledger.ensureWindow("a", { start: T0 + 30 * DAY, end: T0 + 60 * DAY, limit: 10, source: "admin_grant", grantId: "grt_1" });
      await ledger.ensureWindow("a", { start: T0 + 60 * DAY, end: T0 + 90 * DAY, limit: 10, source: "admin_grant", grantId: "grt_2" });
      expect(await ledger.revokeWindows("a", T0 + DAY, { source: "paddle" })).toBe(1);
      expect((await ledger.listWindows("a")).map((x) => x.revokedAt !== null)).toEqual([true, false, false]);
      expect(await ledger.revokeWindows("a", T0 + DAY, { grantId: "grt_2" })).toBe(1);
      expect((await ledger.listWindows("a")).map((x) => x.revokedAt !== null)).toEqual([true, false, true]);
      expect(await ledger.revokeWindows("a", T0 + DAY)).toBe(1); // no filter: whatever is left
    });

    it("truncates: cuts the window that contains the instant, removes unused later ones, leaves earlier ones and keeps usage", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", { start: T0 - 30 * DAY, end: T0, limit: 100 }); // already over
      await ledger.ensureWindow("a", w);
      await ledger.ensureWindow("a", { start: T0 + 30 * DAY, end: T0 + 60 * DAY, limit: 100 });
      await ledger.reserve("a", { requestId: "r1", feature: "chat", logicalModelId: "studentllm-large", credits: 40, now: T0 + 1000, expiresAt: T0 + 100_000, idempotency: null });
      await ledger.settle("a", { requestId: "r1", credits: 40, logicalModelId: "m", now: T0 + 2000 });
      const at = T0 + 10 * DAY;
      expect(await ledger.truncateWindows("a", at)).toBe(2);
      const windows = await ledger.listWindows("a");
      expect(windows.map((x) => [x.start - T0, x.end - T0, x.revokedAt !== null])).toEqual([
        [-30 * DAY, 0, false],
        [0, 10 * DAY, false],
      ]); // the unused later window is gone, so its start is free again
      expect(windows[1]!.used).toBe(40);
      expect(await ledger.getCurrentWindow("a", at - 1)).toMatchObject({ used: 40 });
      expect(await ledger.getCurrentWindow("a", at)).toBeNull();
      expect(await ledger.truncateWindows("a", at)).toBe(0); // repeating changes nothing
      expect(await ledger.truncateWindows("a", at + DAY)).toBe(0); // and never extends
    });

    describe("conditional insert of a grant", () => {
      const spec = (startDays: number, days: number, limit = 10) => ({ start: T0 + startDays * DAY, end: T0 + (startDays + days) * DAY, limit });

      it("inserts all the windows of a grant, as grant windows", async () => {
        const { ledger } = factory();
        const r = await ledger.insertGrantWindows("a", "grt_1", [spec(0, 30), spec(30, 15, 5)]);
        expect(r).toMatchObject({ ok: true, existed: false });
        expect((await ledger.listWindows("a")).map((w) => [w.source, w.grantId, w.limit, w.used])).toEqual([["admin_grant", "grt_1", 10, 0], ["admin_grant", "grt_1", 5, 0]]);
      });

      it("returns the windows of a grant that already exists, unchanged, whatever the new request says", async () => {
        const { ledger } = factory();
        await ledger.insertGrantWindows("a", "grt_1", [spec(0, 30)]);
        await ledger.reserve("a", { requestId: "r", feature: "chat", logicalModelId: "studentllm-large", credits: 4, now: T0 + 1000, expiresAt: T0 + 60_000, idempotency: null });
        await ledger.settle("a", { requestId: "r", credits: 4, logicalModelId: "m", now: T0 + 2000 });
        const again = await ledger.insertGrantWindows("a", "grt_1", [spec(100, 5, 999)]);
        expect(again).toMatchObject({ ok: true, existed: true });
        expect(again.ok && again.windows).toHaveLength(1);
        expect(again.ok && again.windows[0]).toMatchObject({ start: T0, limit: 10, used: 4 });
        expect(await ledger.listWindows("a")).toHaveLength(1);
      });

      it("rejects any overlap with a live or queued window of any source, inserting nothing", async () => {
        const { ledger } = factory();
        await ledger.ensureWindow("a", { start: T0 + 40 * DAY, end: T0 + 70 * DAY, limit: 5 }); // queued paid window
        const r = await ledger.insertGrantWindows("a", "grt_1", [spec(0, 30), spec(30, 30)]); // the second runs into it
        expect(r).toMatchObject({ ok: false, reason: "overlap", conflict: { source: "paddle", start: T0 + 40 * DAY } });
        expect(await ledger.listWindows("a")).toHaveLength(1); // all or nothing
        expect((await ledger.insertGrantWindows("a", "grt_2", [spec(70, 10)])).ok).toBe(true); // touching at the edge is not an overlap
      });

      it("ignores revoked windows for overlap, but a start they use is taken", async () => {
        const { ledger } = factory();
        await ledger.ensureWindow("a", { start: T0, end: T0 + 30 * DAY, limit: 5 });
        await ledger.revokeWindows("a", T0);
        expect(await ledger.insertGrantWindows("a", "grt_1", [spec(0, 10)])).toEqual({ ok: false, reason: "start_taken" });
        expect((await ledger.insertGrantWindows("a", "grt_1", [spec(1, 10)])).ok).toBe(true);
      });

      it("of parallel inserts for the same time exactly one wins, whole", async () => {
        const { ledger } = factory();
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.insertGrantWindows("a", `grt_${i}`, [spec(0, 30), spec(30, 30)])));
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(await ledger.listWindows("a")).toHaveLength(2);
      });

      it("keeps accounts apart", async () => {
        const { ledger } = factory();
        await ledger.insertGrantWindows("a", "grt_1", [spec(0, 30)]);
        expect((await ledger.insertGrantWindows("b", "grt_1", [spec(0, 30)])).ok).toBe(true);
        expect(await ledger.listWindows("a")).toHaveLength(1);
        expect(await ledger.listWindows("b")).toHaveLength(1);
      });
    });

    it("targets exactly one window by its start", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", w);
      await ledger.ensureWindow("a", { start: T0 + 30 * DAY, end: T0 + 60 * DAY, limit: 100 });
      expect(await ledger.revokeWindows("a", T0, { start: T0 + 30 * DAY })).toBe(1);
      expect((await ledger.listWindows("a")).map((x) => x.revokedAt !== null)).toEqual([false, true]);
      expect(await ledger.truncateWindows("a", T0 + 10 * DAY, { start: T0 })).toBe(1);
      expect((await ledger.listWindows("a"))[0]!.end).toBe(T0 + 10 * DAY);
    });

    it("truncates only the matching source; a window starting exactly at the instant is removed when unused and revoked when used", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", w);
      await ledger.ensureWindow("a", { start: T0 + 30 * DAY, end: T0 + 60 * DAY, limit: 10, source: "admin_grant", grantId: "grt_1" });
      expect(await ledger.truncateWindows("a", T0 + 30 * DAY, { source: "admin_grant" })).toBe(1);
      expect((await ledger.listWindows("a")).map((x) => x.source)).toEqual(["paddle"]);
      expect((await ledger.listWindows("a"))[0]).toMatchObject({ end: T0 + 30 * DAY + 0 * DAY, revokedAt: null });
      // A start that was freed can be used by a window of another source.
      expect((await ledger.ensureWindow("a", { start: T0 + 30 * DAY, end: T0 + 60 * DAY, limit: 5 })).source).toBe("paddle");
      // A window that already has usage is revoked, not removed.
      await ledger.ensureWindow("a", { start: T0 + 60 * DAY, end: T0 + 90 * DAY, limit: 10, source: "admin_grant", grantId: "grt_2" });
      await ledger.reserve("a", { requestId: "u1", feature: "chat", logicalModelId: "studentllm-large", credits: 3, now: T0 + 61 * DAY, expiresAt: T0 + 61 * DAY + 60_000, idempotency: null });
      await ledger.settle("a", { requestId: "u1", credits: 3, logicalModelId: "m", now: T0 + 61 * DAY + 1 });
      expect(await ledger.truncateWindows("a", T0 + 60 * DAY, { source: "admin_grant" })).toBe(1);
      const last = (await ledger.listWindows("a")).find((x) => x.grantId === "grt_2");
      expect(last).toMatchObject({ revokedAt: T0 + 60 * DAY, used: 3 });
    });
  });
}
