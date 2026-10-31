// Complimentary windows: the groundwork the admin interface will call (docs/cloud-admin.md, "Grant a complimentary
// period"). These tests pin how a window with source admin_grant composes with the plan rules.

import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "../../storage";
import { TEST_START_MS } from "../../testing";
import { adjustmentEvent, makeBillingTestApp, subscriptionEvent, transactionEvent, type BillingTestApp } from "../../testing/billing-test-app";
import { chaosStores } from "../../testing/store-contract";
import { envFromDeps } from "./env";
import { createGrantWindows, GRANT_WINDOW_DAYS, planGrantWindows, revokeGrantWindows, shortenGrantWindows } from "./grants";
import { addMonthsUTC } from "./windows";

const T = TEST_START_MS;
const DAY = 24 * 60 * 60 * 1000;

async function setup(options: Parameters<typeof makeBillingTestApp>[0] = {}) {
  const app = makeBillingTestApp(options);
  await app.createAccount();
  const env = envFromDeps(app.t.deps);
  return { app, env, grant: (req: Parameters<typeof createGrantWindows>[2]) => createGrantWindows(env, "acc_test", req) };
}

const live = async (app: BillingTestApp) => (await app.stores.ledger.listWindows("acc_test")).filter((w) => w.revokedAt === null);
const openAt = async (app: BillingTestApp, at: number) => (await live(app)).filter((w) => w.start <= at && at < w.end);
const version = async (app: BillingTestApp) => (await app.stores.accounts.getById("acc_test"))!.planVersion;

const subscribe = (app: BillingTestApp, at: number, id = "sub_1") =>
  app.webhook(subscriptionEvent({ type: "subscription.created", subscriptionId: id, occurredAt: at, periodStart: at, periodEnd: addMonthsUTC(at, 1), customerId: "ctm_1" }));
const buyPass = (app: BillingTestApp, txn: string, at: number) => app.webhook(transactionEvent({ transactionId: txn, occurredAt: at, customerId: "ctm_1" }));

describe("planGrantWindows", () => {
  it("cuts a grant into windows of at most 30 days; the last is prorated and its budget rounded down", () => {
    const w = (days: number, credits = 12_500) => planGrantWindows(T, days, credits).map((x) => [(x.end - x.start) / DAY, x.limit]);
    expect(w(1)).toEqual([[1, 416]]); // floor(12500 / 30)
    expect(w(30)).toEqual([[30, 12_500]]);
    expect(w(31)).toEqual([[30, 12_500], [1, 416]]);
    expect(w(45)).toEqual([[30, 12_500], [15, 6250]]);
    expect(w(90)).toEqual([[30, 12_500], [30, 12_500], [30, 12_500]]); // a 90-day grant is three windows
    expect(w(7, 100)).toEqual([[7, 23]]);
    expect(w(1, 1)).toEqual([[1, 1]]); // never a window with no budget
  });

  it("makes contiguous windows from the start", () => {
    const windows = planGrantWindows(T, 75, 100);
    expect(windows[0]!.start).toBe(T);
    windows.forEach((x, i) => i > 0 && expect(x.start).toBe(windows[i - 1]!.end));
    expect(windows.at(-1)!.end).toBe(T + 75 * DAY);
    expect(GRANT_WINDOW_DAYS).toBe(30);
  });

  it("enforces the day ceiling and whole positive budgets (the credit ceilings come from W, see below)", () => {
    for (const days of [0, -1, 91, 1.5, NaN]) expect(() => planGrantWindows(T, days, 100), String(days)).toThrow(RangeError);
    for (const credits of [0, -5, 1.5]) expect(() => planGrantWindows(T, 10, credits), String(credits)).toThrow(RangeError);
    expect(() => planGrantWindows(T, 90, 25_000)).not.toThrow();
  });
});

describe("creating a grant", () => {
  it("makes admin_grant windows with their own budget, and bumps the plan version so the app refetches", async () => {
    const { app, grant } = await setup();
    const before = await version(app);
    const out = await grant({ grantId: "grt_1", days: 60, creditsPerWindow: 5000, startPolicy: "now" });
    expect(out).toMatchObject({ ok: true, startsAt: T, endsAt: T + 60 * DAY });
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.map((w) => [w.source, w.grantId, w.limit, w.start - T, w.end - T])).toEqual([
      ["admin_grant", "grt_1", 5000, 0, 30 * DAY],
      ["admin_grant", "grt_1", 5000, 30 * DAY, 60 * DAY],
    ]);
    expect(await version(app)).toBe(before + 1);
    expect((await app.stores.accounts.getPlan("acc_test"))!.paidPeriods).toEqual([]); // no payment, no Paddle object: only the customer row
  });

  it("defaults the budget to the standard Plus window", async () => {
    const { app, grant } = await setup();
    await grant({ grantId: "grt_1", days: 10, startPolicy: "now" });
    expect((await live(app))[0]!.limit).toBe(Math.floor((app.billing.settings.windowCredits.plus_monthly * 10) / 30));
  });

  it("opens the content routes (a window is a plan) and lapses to a free account when it ends", async () => {
    const { app, grant } = await setup();
    await grant({ grantId: "grt_1", days: 5, startPolicy: "now" });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 5 * DAY - 1)).not.toBeNull();
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 5 * DAY)).toBeNull(); // no automatic conversion or charge
  });

  it("is idempotent for a replay at the same instant: it finds its own windows and creates none", async () => {
    const { app, grant } = await setup();
    const first = await grant({ grantId: "grt_1", days: 45, startPolicy: "now" });
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 10, now: T + 1000, expiresAt: T + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 10, logicalModelId: "m", now: T + 2000 });
    const again = await grant({ grantId: "grt_1", days: 45, startPolicy: "now" });
    expect(again.ok && first.ok && again.windows.map((w) => w.start)).toEqual(first.ok ? first.windows.map((w) => w.start) : []);
    expect(await app.stores.ledger.listWindows("acc_test")).toHaveLength(2);
    expect((await app.stores.ledger.getCurrentWindow("acc_test", T + 3000))!.used).toBe(10); // never reset
  });
});

describe("composition with the plan rules", () => {
  it("start_policy now is refused while a paid or a granted window is active, naming the source and the end", async () => {
    const { app, grant } = await setup();
    await subscribe(app, T);
    expect(await grant({ grantId: "g", days: 10, startPolicy: "now" })).toEqual({ ok: false, reason: "window_overlap", conflict: { source: "paddle", end: addMonthsUTC(T, 1) } });

    const other = await setup();
    await other.grant({ grantId: "g1", days: 10, startPolicy: "now" });
    expect(await other.grant({ grantId: "g2", days: 10, startPolicy: "now" })).toEqual({ ok: false, reason: "window_overlap", conflict: { source: "admin_grant", end: T + 10 * DAY } });
    expect(await live(other.app)).toHaveLength(1); // nothing from the refused grant

    const pass = await setup();
    await buyPass(pass.app, "txn_p", T);
    const refused = await pass.grant({ grantId: "g", days: 10, startPolicy: "now" });
    expect(refused).toMatchObject({ ok: false, reason: "window_overlap", conflict: { source: "paddle" } });
  });

  it("start_policy now is also refused when the grant would run into a later window", async () => {
    const { app, grant } = await setup();
    await buyPass(app, "txn_p", T + 20 * DAY);
    app.clock.set(T); // no window is active yet, but the pass window starts in 20 days
    expect(await grant({ grantId: "g", days: 30, startPolicy: "now" })).toMatchObject({ ok: false, reason: "window_overlap" });
    expect(await grant({ grantId: "g", days: 20, startPolicy: "now" })).toMatchObject({ ok: true }); // ends exactly where the pass begins
  });

  it("after_current_windows queues behind a pass, a grant, and a subscription set to cancel at period end", async () => {
    const pass = await setup();
    await buyPass(pass.app, "txn_p", T);
    const queued = await pass.grant({ grantId: "g", days: 10, startPolicy: "after_current_windows" });
    expect(queued).toMatchObject({ ok: true, startsAt: addMonthsUTC(T, 5) });

    const chain = await setup();
    await chain.grant({ grantId: "g1", days: 10, startPolicy: "now" });
    expect(await chain.grant({ grantId: "g2", days: 10, startPolicy: "after_current_windows" })).toMatchObject({ ok: true, startsAt: T + 10 * DAY, endsAt: T + 20 * DAY });
    expect(await chain.grant({ grantId: "g3", days: 5, startPolicy: "after_current_windows" })).toMatchObject({ ok: true, startsAt: T + 20 * DAY });

    const cancelling = await setup();
    await subscribe(cancelling.app, T);
    await cancelling.app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + DAY, scheduled: "cancel", periodStart: T, periodEnd: addMonthsUTC(T, 1), customerId: "ctm_1" }));
    expect(await cancelling.grant({ grantId: "g", days: 10, startPolicy: "after_current_windows" })).toMatchObject({ ok: true, startsAt: addMonthsUTC(T, 1) });
  });

  it("after_current_windows is refused for a subscription that renews on its own (its end is unknown)", async () => {
    const { app, grant } = await setup();
    await subscribe(app, T);
    expect(await grant({ grantId: "g", days: 10, startPolicy: "after_current_windows" })).toEqual({ ok: false, reason: "window_overlap", conflict: { source: "paddle", end: null } });
    expect(await live(app)).toHaveLength(1);
  });

  it("with nothing active, after_current_windows starts now", async () => {
    const { grant } = await setup();
    expect(await grant({ grantId: "g", days: 3, startPolicy: "after_current_windows" })).toMatchObject({ ok: true, startsAt: T });
  });

  it("past_due: a grant is refused while the paid window runs and allowed once it ended; the payment then cuts it", async () => {
    const { app, grant } = await setup();
    await subscribe(app, T);
    const renewal = addMonthsUTC(T, 1);
    await app.webhook(subscriptionEvent({ type: "subscription.past_due", subscriptionId: "sub_1", status: "past_due", occurredAt: renewal + 60_000, customerId: "ctm_1" }));
    app.clock.set(renewal - 1000);
    expect(await grant({ grantId: "g", days: 10, startPolicy: "now" })).toMatchObject({ ok: false, reason: "window_overlap" });
    app.clock.set(renewal + 2 * DAY);
    expect(await grant({ grantId: "g", days: 10, startPolicy: "now" })).toMatchObject({ ok: true, startsAt: renewal + 2 * DAY });
    // The payment succeeds on day 5 of the renewal period: the paid window starts at the period Paddle reports.
    await app.webhook(transactionEvent({ transactionId: "txn_2", subscriptionId: "sub_1", occurredAt: renewal + 5 * DAY, periodStart: renewal, periodEnd: addMonthsUTC(T, 2), customerId: "ctm_1" }));
    for (const at of [renewal, renewal + 3 * DAY, renewal + 7 * DAY, addMonthsUTC(T, 2) - 1]) expect(await openAt(app, at), String(at - renewal)).toHaveLength(1);
    const grantWindow = (await app.stores.ledger.listWindows("acc_test")).find((w) => w.grantId === "g");
    expect(grantWindow).toBeUndefined(); // it started inside the paid period: removed
  });

  it("an active grant does not count as an active plan: a purchase is allowed and cuts the grant at the purchase instant", async () => {
    const { app, grant } = await setup();
    await grant({ grantId: "g", days: 30, creditsPerWindow: 5000, startPolicy: "now" });
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 700, now: T + DAY, expiresAt: T + DAY + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 700, logicalModelId: "m", now: T + DAY + 1 });

    app.clock.set(T + 5 * DAY);
    const res = await app.as("/v1/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: "plus_monthly" }) });
    expect(res.status).toBe(200); // not already_subscribed

    const at = T + 5 * DAY;
    await subscribe(app, at);
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.map((w) => [w.source, w.start - T, w.end - T, w.used])).toEqual([
      ["admin_grant", 0, 5 * DAY, 700], // cut where the paid window begins; the used credits stay used
      ["paddle", 5 * DAY, addMonthsUTC(at, 1) - T, 0],
    ]);
    for (const instant of [T, T + 4 * DAY, at, at + DAY, addMonthsUTC(at, 1) - 1]) expect(await openAt(app, instant)).toHaveLength(1);
    expect((await app.stores.ledger.getCurrentWindow("acc_test", at))!.limit).toBe(app.billing.settings.windowCredits.plus_monthly); // not 5000, and nothing stacked
  });

  it("a pass bought during a grant also cuts it, and a pass queued behind a grant takes the grant's place", async () => {
    const { app, grant } = await setup();
    await grant({ grantId: "g", days: 30, startPolicy: "now" });
    await buyPass(app, "txn_p", T + 10 * DAY);
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.map((w) => w.source)).toEqual(["admin_grant", "paddle", "paddle", "paddle", "paddle", "paddle"]);
    expect(windows[0]!.end).toBe(T + 10 * DAY);
    expect(windows[1]!.start).toBe(T + 10 * DAY);

    // A grant queued behind pass A starts exactly where pass B (bought during A) would queue: the paid window wins.
    const queue = await setup();
    await buyPass(queue.app, "txn_a", T);
    const queued = await queue.grant({ grantId: "g", days: 20, startPolicy: "after_current_windows" });
    expect(queued).toMatchObject({ ok: true, startsAt: addMonthsUTC(T, 5) });
    await buyPass(queue.app, "txn_b", T + 20 * DAY);
    const all = await queue.app.stores.ledger.listWindows("acc_test");
    expect(all.filter((w) => w.source === "admin_grant")).toEqual([]);
    expect(all).toHaveLength(10);
    expect(all[5]!.start).toBe(addMonthsUTC(T, 5)); // the key of the removed grant window is free for pass B
    for (let i = 1; i < all.length; i++) expect(all[i]!.start).toBe(all[i - 1]!.end);
  });

  it("refunds and chargebacks revoke only Paddle windows: a grant queued behind the refunded pass survives", async () => {
    const { app, grant } = await setup();
    await buyPass(app, "txn_p", T);
    await grant({ grantId: "g", days: 20, startPolicy: "after_current_windows" });
    await app.webhook(adjustmentEvent({ occurredAt: T + 3 * DAY, transactionId: "txn_p", action: "chargeback", customerId: "ctm_1" }));
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.filter((w) => w.source === "paddle").every((w) => w.revokedAt !== null)).toBe(true);
    const g = windows.filter((w) => w.source === "admin_grant");
    expect(g).toHaveLength(1);
    expect(g[0]!.revokedAt).toBeNull();
    expect(await app.stores.ledger.getCurrentWindow("acc_test", addMonthsUTC(T, 5) + DAY)).toMatchObject({ source: "admin_grant" });
  });

  it("replaying a purchase never resets a budget: the paid window keeps its usage", async () => {
    const { app, grant } = await setup();
    await grant({ grantId: "g", days: 10, startPolicy: "now" });
    await subscribe(app, T + 2 * DAY);
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 50, now: T + 3 * DAY, expiresAt: T + 3 * DAY + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 50, logicalModelId: "m", now: T + 3 * DAY + 1 });
    await app.webhook(subscriptionEvent({ subscriptionId: "sub_1", occurredAt: T + 4 * DAY, periodStart: T + 2 * DAY, periodEnd: addMonthsUTC(T + 2 * DAY, 1), customerId: "ctm_1" }));
    expect((await app.stores.ledger.getCurrentWindow("acc_test", T + 4 * DAY))!.used).toBe(50);
    expect(await live(app)).toHaveLength(2);
  });
});

describe("shortening and revoking a grant", () => {
  it("shortens: windows after the new end are removed, the one that contains it is cut, used credits stay", async () => {
    const { app, env, grant } = await setup();
    await grant({ grantId: "g", days: 90, creditsPerWindow: 1000, startPolicy: "now" });
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 40, now: T + 35 * DAY, expiresAt: T + 35 * DAY + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 40, logicalModelId: "m", now: T + 35 * DAY + 1 });
    const before = await version(app);
    app.clock.set(T + 36 * DAY);
    expect(await shortenGrantWindows(env, "acc_test", "g", T + 40 * DAY)).toEqual({ ok: true, changed: 2 });
    const windows = await app.stores.ledger.listWindows("acc_test");
    expect(windows.map((w) => [w.start / DAY - T / DAY, w.end / DAY - T / DAY, w.used])).toEqual([[0, 30, 0], [30, 40, 40]]);
    expect(await version(app)).toBe(before + 1);
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 40 * DAY)).toBeNull();
  });

  it("never moves the end later, and reports an unknown grant", async () => {
    const { app, env, grant } = await setup();
    await grant({ grantId: "g", days: 10, startPolicy: "now" });
    const before = await version(app);
    expect(await shortenGrantWindows(env, "acc_test", "g", T + 10 * DAY)).toEqual({ ok: false, reason: "not_earlier" });
    expect(await shortenGrantWindows(env, "acc_test", "g", T + 20 * DAY)).toEqual({ ok: false, reason: "not_earlier" });
    expect(await shortenGrantWindows(env, "acc_test", "ghost", T + 5 * DAY)).toEqual({ ok: false, reason: "not_found" });
    expect(await version(app)).toBe(before);
    expect((await live(app))[0]!.end).toBe(T + 10 * DAY);
  });

  it("revokes: the remaining credits become unusable now, only this grant's windows are touched", async () => {
    const { app, env, grant } = await setup();
    await grant({ grantId: "g1", days: 10, startPolicy: "now" });
    await grant({ grantId: "g2", days: 10, startPolicy: "after_current_windows" });
    await app.stores.ledger.reserve("acc_test", { requestId: "r1", feature: "chat", credits: 5, now: T + DAY, expiresAt: T + DAY + 60_000, idempotency: null });
    await app.stores.ledger.settle("acc_test", { requestId: "r1", credits: 5, logicalModelId: "m", now: T + DAY + 1 });
    app.clock.set(T + 2 * DAY);
    const before = await version(app);
    expect(await revokeGrantWindows(env, "acc_test", "g1")).toEqual({ changed: 1 });
    expect(await app.stores.ledger.getCurrentWindow("acc_test", T + 2 * DAY)).toBeNull();
    const [g1, g2] = await app.stores.ledger.listWindows("acc_test");
    expect(g1).toMatchObject({ grantId: "g1", revokedAt: T + 2 * DAY, used: 5 });
    expect(g2).toMatchObject({ grantId: "g2", revokedAt: null });
    expect(await version(app)).toBe(before + 1);
    expect(await revokeGrantWindows(env, "acc_test", "g1")).toEqual({ changed: 0 }); // idempotent, no second bump
    expect(await version(app)).toBe(before + 1);
  });

  it("a paid window is not touched by shortening or revoking a grant", async () => {
    const { app, env, grant } = await setup();
    await buyPass(app, "txn_p", T);
    await grant({ grantId: "g", days: 10, startPolicy: "after_current_windows" });
    app.clock.set(T + DAY);
    await revokeGrantWindows(env, "acc_test", "g");
    await shortenGrantWindows(env, "acc_test", "g", T + DAY);
    const paid = (await app.stores.ledger.listWindows("acc_test")).filter((w) => w.source === "paddle");
    expect(paid).toHaveLength(5);
    expect(paid.every((w) => w.revokedAt === null)).toBe(true);
  });
});

describe("invariants under a mix of purchases, grants and refunds", () => {
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("never has two windows open at the same instant, never loses used credits", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const { app, env } = await setup({ stores: seed % 10 === 0 ? chaosStores(createInMemoryStores(), seed) : createInMemoryStores() });
      let now = T;
      let n = 0;
      let used = 0;
      for (let step = 0; step < 14; step++) {
        now += Math.floor(r() * 25 * DAY);
        app.clock.set(now);
        n++;
        const pick = r();
        if (pick < 0.3) await createGrantWindows(env, "acc_test", { grantId: `g${n}`, days: 1 + Math.floor(r() * 89), startPolicy: r() < 0.5 ? "now" : "after_current_windows" });
        else if (pick < 0.5) await buyPass(app, `txn_${n}`, now);
        else if (pick < 0.65) await subscribe(app, now, `sub_${n}`);
        else if (pick < 0.75) await app.webhook(adjustmentEvent({ occurredAt: now, transactionId: null, customerId: "ctm_1" }));
        else if (pick < 0.85) await revokeGrantWindows(env, "acc_test", `g${Math.max(1, n - 1)}`);
        else if (pick < 0.92) await shortenGrantWindows(env, "acc_test", `g${Math.max(1, n - 2)}`, now + DAY);
        else {
          const w = await app.stores.ledger.getCurrentWindow("acc_test", now);
          if (w && w.limit - w.used - w.reserved >= 3) {
            const id = `r${n}`;
            await app.stores.ledger.reserve("acc_test", { requestId: id, feature: "chat", credits: 3, now, expiresAt: now + 60_000, idempotency: null });
            await app.stores.ledger.settle("acc_test", { requestId: id, credits: 3, logicalModelId: "m", now });
            used += 3;
          }
        }
        const windows = await live(app);
        const sorted = [...windows].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start, `seed ${seed} step ${step}`).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
      }
      const total = (await app.stores.ledger.listWindows("acc_test")).reduce((sum, w) => sum + w.used, 0);
      expect(total, `seed ${seed}`).toBe(used);
    }
  }, 60_000);
});
