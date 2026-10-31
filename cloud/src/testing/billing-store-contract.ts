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

    it("keeps the Paddle ids in the tombstone while a cancellation is pending", async () => {
      const stores = await accountWith();
      await stores.accounts.applyPlanEvent("acc_1", T0, () => plan({ pendingCancel: { when: "now", requestedAt: T0, attempts: 0, nextAttemptAt: T0, alerted: false } }));
      const t = await stores.accounts.markDeleting("acc_1", T0 + 1);
      expect(t).toMatchObject({ paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1" });
      expect(await stores.accounts.listPendingCancels(T0 + 1, 10)).toEqual(["acc_1"]);
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
      await ledger.reserve("a", { requestId: "r1", feature: "chat", credits: 40, now: T0 + 1000, expiresAt: T0 + 100_000, idempotency: null });
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
      await ledger.reserve("a", { requestId: "u1", feature: "chat", credits: 3, now: T0 + 61 * DAY, expiresAt: T0 + 61 * DAY + 60_000, idempotency: null });
      await ledger.settle("a", { requestId: "u1", credits: 3, logicalModelId: "m", now: T0 + 61 * DAY + 1 });
      expect(await ledger.truncateWindows("a", T0 + 60 * DAY, { source: "admin_grant" })).toBe(1);
      const last = (await ledger.listWindows("a")).find((x) => x.grantId === "grt_2");
      expect(last).toMatchObject({ revokedAt: T0 + 60 * DAY, used: 3 });
    });
  });
}
