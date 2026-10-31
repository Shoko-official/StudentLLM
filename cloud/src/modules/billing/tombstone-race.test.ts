// The tombstone cancel must never finish (`done`) while a Paddle subscription of the deleted account is still alive:
// not when a stray arrives before the first cancel, not when it arrives while a cancel is in flight, and not under any
// interleaving of strays, cancels, confirmations and failures.

import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "../../storage";
import { TEST_START_MS } from "../../testing";
import { makeBillingTestApp, subscriptionEvent, type BillingTestApp } from "../../testing/billing-test-app";
import { chaosStores } from "../../testing/store-contract";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const DAY = 24 * 60 * 60 * 1000;

const monthly = (at: number, id: string) =>
  subscriptionEvent({ type: "subscription.created", subscriptionId: id, occurredAt: at, periodStart: at, periodEnd: addMonthsUTC(at, 1), customerId: "ctm_1" });
const live = (app: BillingTestApp, id: string) => app.paddle.subscriptions.set(id, { id, status: "active", customerId: "ctm_1", periodStart: T, periodEnd: addMonthsUTC(T, 1), cancelScheduled: false });
const statusAtPaddle = (app: BillingTestApp, id: string) => app.paddle.subscriptions.get(id)?.status ?? "unknown";
const runCron = (app: BillingTestApp) => app.t.app.scheduled({ scheduledTime: app.clock.now(), cron: "* * * * *" });
const waitForCalls = async (app: BillingTestApp, n: number) => {
  while (app.paddle.callsTo("cancelSubscription").length < n) await new Promise((r) => setTimeout(r, 1));
};

/** An account with one subscription (sub_1), already deleted: only the tombstone is left. */
async function deletedWithOne(options: Parameters<typeof makeBillingTestApp>[0] = {}) {
  const app = makeBillingTestApp(options);
  await app.createAccount();
  await app.webhook(monthly(T, "sub_1"));
  live(app, "sub_1");
  await app.stores.accounts.markDeleting("acc_test", T + DAY);
  app.paddle.calls.length = 0;
  return app;
}

/** The invariant: a tombstone whose cancel is `done` has every one of its subscriptions canceled at Paddle. */
async function expectDoneMeansCanceled(app: BillingTestApp, label = "") {
  const tomb = await app.stores.accounts.getTombstone("acc_test");
  if (tomb?.cancel?.state !== "done") return;
  const ids = [...new Set([...(tomb.paddleSubscriptionId ? [tomb.paddleSubscriptionId] : []), ...(tomb.paddleSubscriptionIds ?? [])])];
  for (const id of ids) expect(statusAtPaddle(app, id), `${label} ${id}`).toBe("canceled");
}

describe("a stray subscription arrives before the first cancel", () => {
  it("cancels the account's own subscription too, so the tombstone is not done with sub_1 still billing", async () => {
    const app = await deletedWithOne();
    live(app, "sub_stray");
    await app.webhook(monthly(T + DAY, "sub_stray"));
    expect(statusAtPaddle(app, "sub_stray")).toBe("canceled");
    expect(statusAtPaddle(app, "sub_1")).toBe("canceled"); // the bug left this one billing
    expect(app.paddle.callsTo("cancelSubscription").map((c) => c[0]).sort()).toEqual(["sub_1", "sub_stray"]);
    await expectDoneMeansCanceled(app);
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "none" }); // nothing left, and nothing was skipped
  });

  it("keeps the main subscription pending when its own cancel fails, and the deletion call then finishes it", async () => {
    const app = await deletedWithOne();
    live(app, "sub_stray");
    app.paddle.failFor("cancelSubscription", "sub_1");
    await app.webhook(monthly(T + DAY, "sub_stray"));
    const t = (await app.stores.accounts.getTombstone("acc_test"))!;
    expect(t.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_1"], confirmedIds: ["sub_stray"] });
    expect(statusAtPaddle(app, "sub_1")).toBe("active");
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(statusAtPaddle(app, "sub_1")).toBe("canceled");
    await expectDoneMeansCanceled(app);
  });

  it("the same on the retry path: a failed first cancel, a stray, then the scheduled retry", async () => {
    const app = await deletedWithOne();
    app.paddle.failNext("cancelSubscription", "unavailable");
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "pending" });
    live(app, "sub_stray");
    app.paddle.failFor("cancelSubscription", "sub_stray");
    await app.webhook(monthly(T + 2 * DAY, "sub_stray"));
    const t = (await app.stores.accounts.getTombstone("acc_test"))!;
    expect(t.cancel!.state).toBe("pending");
    expect(statusAtPaddle(app, "sub_1")).toBe("canceled"); // the stray's attempt cancelled it too
    expect(t.cancel!.pendingIds).toEqual(["sub_stray"]);
    app.clock.set(t.cancel!.nextAttemptAt);
    await app.billing.cancelSubscription("acc_test", "now");
    expect(statusAtPaddle(app, "sub_stray")).toBe("canceled");
    await expectDoneMeansCanceled(app);
  });
});

describe("a stray subscription arrives while the deletion cancel is in flight", () => {
  async function race(options: Parameters<typeof makeBillingTestApp>[0] = {}) {
    const app = await deletedWithOne(options);
    live(app, "sub_stray");
    const release = app.paddle.hold("cancelSubscription");
    const first = app.billing.cancelSubscription("acc_test", "now"); // takes sub_1 and is held at Paddle
    await waitForCalls(app, 1);
    app.paddle.failFor("cancelSubscription", "sub_stray"); // the stray's own cancel fails
    await app.webhook(monthly(T + 2 * DAY, "sub_stray")); // the stray arrives and is handled while the first call waits
    const mid = (await app.stores.accounts.getTombstone("acc_test"))!;
    release(); // the held call now finishes
    const firstState = await first;
    return { app, mid, firstState };
  }

  it("does not lose the stray's retry when the held call finishes (it used to overwrite the state with done)", async () => {
    const { app, mid, firstState } = await race();
    expect(mid.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_stray"] });
    const t = (await app.stores.accounts.getTombstone("acc_test"))!;
    expect(t.cancel).toMatchObject({ state: "pending", pendingIds: ["sub_stray"] });
    expect(t.cancel!.confirmedIds).toContain("sub_1");
    expect(firstState).toEqual({ state: "pending" }); // the deletion flow must not purge yet
    expect(statusAtPaddle(app, "sub_stray")).toBe("active");
    await expectDoneMeansCanceled(app);
    // The retry is still scheduled, and finishing it ends the job.
    expect(await app.stores.accounts.listPendingCancels(t.cancel!.nextAttemptAt, 10)).toEqual(["acc_test"]);
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    expect(statusAtPaddle(app, "sub_stray")).toBe("canceled");
    await expectDoneMeansCanceled(app);
  });

  it("the same race under a store that reorders concurrent callers", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { app } = await race({ stores: chaosStores(createInMemoryStores(), seed) });
      const t = (await app.stores.accounts.getTombstone("acc_test"))!;
      expect(t.cancel, `seed ${seed}`).toMatchObject({ state: "pending", pendingIds: ["sub_stray"] });
      expect(statusAtPaddle(app, "sub_stray")).toBe("active");
      expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
      await expectDoneMeansCanceled(app, `seed ${seed}`);
    }
  });

  it("a confirmation that arrives meanwhile is kept too", async () => {
    const app = await deletedWithOne();
    live(app, "sub_stray");
    app.paddle.failFor("cancelSubscription", "sub_stray");
    await app.webhook(monthly(T + 2 * DAY, "sub_stray")); // pending: sub_stray
    app.paddle.subscriptions.set("sub_stray", { ...app.paddle.subscriptions.get("sub_stray")!, status: "canceled" });
    await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: "sub_stray", status: "canceled", occurredAt: T + 3 * DAY, customerId: "ctm_1" }));
    expect((await app.stores.accounts.getTombstone("acc_test"))!.cancel).toMatchObject({ state: "done", pendingIds: [] });
    await expectDoneMeansCanceled(app);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: after any interleaving of strays, cancels, confirmations and failures", () => {
  it("done implies every subscription the tombstone lists was canceled at Paddle, and a healthy run ends done", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      const stores = seed % 4 === 0 ? chaosStores(createInMemoryStores(), seed) : createInMemoryStores();
      const app = await deletedWithOne({ stores });
      const strays: string[] = [];
      const ops: Array<() => Promise<unknown>> = [];
      const steps = 6 + Math.floor(rnd() * 8);
      for (let i = 0; i < steps; i++) {
        const pick = rnd();
        if (pick < 0.3) {
          const id = `sub_stray_${strays.length}`;
          strays.push(id);
          live(app, id);
          if (rnd() < 0.5) app.paddle.failFor("cancelSubscription", id);
          ops.push(() => app.webhook(monthly(app.clock.now(), id)));
        } else if (pick < 0.6) {
          if (rnd() < 0.4) app.paddle.failNext("cancelSubscription", "unavailable");
          ops.push(() => app.billing.cancelSubscription("acc_test", "now"));
        } else if (pick < 0.8) {
          const id = strays.length > 0 && rnd() < 0.7 ? strays[Math.floor(rnd() * strays.length)]! : "sub_1";
          ops.push(async () => {
            // Paddle really canceled it, then tells us.
            const current = app.paddle.subscriptions.get(id);
            if (current) app.paddle.subscriptions.set(id, { ...current, status: "canceled" });
            await app.webhook(subscriptionEvent({ type: "subscription.canceled", subscriptionId: id, status: "canceled", occurredAt: app.clock.now(), customerId: "ctm_1" }));
          });
        } else {
          if (rnd() < 0.5) app.paddle.failNext("cancelSubscription", "unavailable");
          ops.push(async () => {
            app.clock.advance(app.billing.settings.cancel.maxDelayMs);
            const { retryPendingCancels } = await import("./cancel");
            const { envFromDeps } = await import("./env");
            await retryPendingCancels(envFromDeps(app.t.deps));
          });
        }
      }
      // Run the operations in random parallel batches, checking the invariant between them.
      for (let i = 0; i < ops.length; ) {
        const size = 1 + Math.floor(rnd() * 3);
        await Promise.all(ops.slice(i, i + size).map((op) => op()));
        i += size;
        await expectDoneMeansCanceled(app, `seed ${seed} step ${i}`);
      }
      // Heal Paddle and finish: the job must end done, with everything canceled.
      app.paddle.clearFailures();
      let state = "pending";
      for (let tries = 0; tries < 5 && state === "pending"; tries++) state = (await app.billing.cancelSubscription("acc_test", "now")).state;
      expect(state === "cancelled" || state === "none", `seed ${seed}`).toBe(true);
      const tomb = (await app.stores.accounts.getTombstone("acc_test"))!;
      expect(tomb.cancel?.state ?? "done", `seed ${seed}`).toBe("done");
      for (const id of ["sub_1", ...strays.filter((s) => (tomb.paddleSubscriptionIds ?? []).includes(s))]) expect(statusAtPaddle(app, id), `seed ${seed} ${id}`).toBe("canceled");
      await expectDoneMeansCanceled(app, `seed ${seed} end`);
    }
  }, 120_000);

  it("a stray that arrives after the job is done re-opens it and is canceled as well", async () => {
    const app = await deletedWithOne();
    expect(await app.billing.cancelSubscription("acc_test", "now")).toEqual({ state: "cancelled" });
    live(app, "sub_late");
    await app.webhook(monthly(T + 5 * DAY, "sub_late"));
    expect(statusAtPaddle(app, "sub_late")).toBe("canceled");
    await expectDoneMeansCanceled(app);
    await runCron(app); // the account module's retry may now purge the tombstone: it was cancelled
    await expectDoneMeansCanceled(app);
  });
});

describe("alerts about a stray subscription are not repeated", () => {
  it("one quarantine alert and one purchase_while_deleting per stray subscription id, however many events Paddle sends", async () => {
    const app = await deletedWithOne();
    live(app, "sub_stray");
    await app.webhook(monthly(T + DAY, "sub_stray"));
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_stray", status: "active", occurredAt: T + 2 * DAY, periodStart: T + DAY, periodEnd: addMonthsUTC(T + DAY, 1), customerId: "ctm_1" }));
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_stray", status: "active", occurredAt: T + 3 * DAY, customerId: "ctm_1" }));
    const alerts = app.notifier.alerts.filter((a) => (a as { subscriptionId?: string }).subscriptionId === "sub_stray" || a.kind === "purchase_while_deleting");
    expect(alerts.filter((a) => a.kind === "webhook_quarantined")).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "purchase_while_deleting")).toHaveLength(1);
    // A second stray subscription is a new thing to tell.
    live(app, "sub_stray_2");
    await app.webhook(monthly(T + 4 * DAY, "sub_stray_2"));
    expect(app.notifier.alerts.filter((a) => a.kind === "webhook_quarantined")).toHaveLength(2);
    await expectDoneMeansCanceled(app);
  });
});
