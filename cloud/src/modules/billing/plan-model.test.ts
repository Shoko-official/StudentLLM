import { describe, expect, it } from "vitest";
import type { PlanRecord } from "../../storage";
import type { NormalizedEvent } from "./events";
import {
  applyConfirmedCancel,
  checkoutEligibility,
  emptyPlan,
  passActive,
  reduceEvent,
  subscriptionRunning,
  toPublicPlan,
  type Prices,
  type Reduction,
} from "./plan-model";
import { addMonthsUTC, liveDays, livePeriods, noOverlap } from "./windows";

const PRICES: Prices = { plus_monthly: "pri_m", plus_semester: "pri_s" };
const T = Date.UTC(2026, 10, 1, 9, 30);
const DAY = 24 * 60 * 60 * 1000;
const ACC = "acc_1";

function ev(over: Partial<NormalizedEvent> & Pick<NormalizedEvent, "kind" | "occurredAt">): NormalizedEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    eventType: over.kind === "subscription" ? "subscription.updated" : over.kind === "adjustment" ? "adjustment.updated" : "transaction.completed",
    subscriptionId: null,
    customerId: "ctm_1",
    transactionId: null,
    adjustmentId: null,
    priceIds: [],
    status: null,
    action: null,
    adjustmentType: null,
    itemCount: over.kind === "adjustment" ? 0 : 1,
    currency: "EUR",
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: null,
    accountHint: ACC,
    ...over,
  };
}

const sub = (at: number, over: Partial<NormalizedEvent> = {}) =>
  ev({ kind: "subscription", occurredAt: at, subscriptionId: "sub_1", status: "active", priceIds: ["pri_m"], periodStart: T, periodEnd: addMonthsUTC(T, 1), ...over });
const pay = (at: number, txn: string, over: Partial<NormalizedEvent> = {}) =>
  ev({ kind: "transaction", occurredAt: at, transactionId: txn, subscriptionId: "sub_1", priceIds: ["pri_m"], periodStart: T, periodEnd: addMonthsUTC(T, 1), ...over });
const pass = (at: number, txn: string, over: Partial<NormalizedEvent> = {}) => ev({ kind: "transaction", occurredAt: at, transactionId: txn, priceIds: ["pri_s"], ...over });
const refund = (at: number, txn: string | null, over: Partial<NormalizedEvent> = {}) =>
  ev({ kind: "adjustment", occurredAt: at, transactionId: txn, action: "refund", status: "approved", adjustmentType: "full", ...over });

const apply = (current: PlanRecord | null, e: NormalizedEvent, mode: "full" | "additive" = "full"): Reduction => reduceEvent(current, e, { accountId: ACC, prices: PRICES, mode });
function run(events: NormalizedEvent[]): PlanRecord | null {
  let plan = null as PlanRecord | null;
  for (const e of events) {
    const r = apply(plan, e);
    if (r.kind === "applied") plan = { ...r.plan, lastEventAt: e.occurredAt };
  }
  return plan;
}

describe("the already_subscribed rule (checkoutEligibility)", () => {
  const monthly = run([sub(T)])!;
  const scheduledToCancel = run([sub(T), sub(T + DAY, { cancelAtPeriodEnd: true })])!;
  const passPlan = run([pass(T, "txn_p")])!;

  it("allows anything for a free account", () => {
    expect(checkoutEligibility(null, "plus_monthly", T)).toEqual({ ok: true });
    expect(checkoutEligibility(null, "plus_semester", T)).toEqual({ ok: true });
    expect(checkoutEligibility(emptyPlan(ACC), "plus_monthly", T)).toEqual({ ok: true });
  });

  it("refuses both plans while a subscription is active, including one set to cancel at the period end", () => {
    for (const plan of [monthly, scheduledToCancel]) {
      for (const requested of ["plus_monthly", "plus_semester"] as const) {
        expect(checkoutEligibility(plan, requested, T + DAY), `${plan.cancelAtPeriodEnd} ${requested}`).toEqual({ ok: false, reason: "subscription_active" });
      }
    }
  });

  it("allows buying again once the cancelled period has ended, even before Paddle's cancel event arrives", () => {
    const end = addMonthsUTC(T, 1);
    expect(checkoutEligibility(scheduledToCancel, "plus_monthly", end - 1).ok).toBe(false);
    expect(checkoutEligibility(scheduledToCancel, "plus_monthly", end).ok).toBe(true);
    expect(checkoutEligibility(scheduledToCancel, "plus_semester", end).ok).toBe(true);
  });

  it("refuses a subscription during a pass but allows a pass during a pass (it queues)", () => {
    expect(checkoutEligibility(passPlan, "plus_monthly", T + DAY)).toEqual({ ok: false, reason: "pass_active" });
    expect(checkoutEligibility(passPlan, "plus_semester", T + DAY)).toEqual({ ok: true });
    expect(passActive(passPlan, addMonthsUTC(T, 5) - 1)).toBe(true);
    expect(checkoutEligibility(passPlan, "plus_monthly", addMonthsUTC(T, 5))).toEqual({ ok: true });
  });

  it("still counts a past-due subscription as active (it may recover), but not a canceled or revoked one", () => {
    const pastDue = run([sub(T), sub(T + 5 * DAY, { status: "past_due", periodStart: null, periodEnd: null })])!;
    expect(subscriptionRunning(pastDue, T + 6 * DAY)).toBe(true);
    expect(checkoutEligibility(pastDue, "plus_semester", T + 6 * DAY).ok).toBe(false);
    const canceled = run([sub(T), sub(T + 5 * DAY, { status: "canceled", periodStart: null, periodEnd: null })])!;
    expect(subscriptionRunning(canceled, T + 6 * DAY)).toBe(false);
    expect(checkoutEligibility(canceled, "plus_monthly", T + 6 * DAY).ok).toBe(true);
    const revoked = run([sub(T), pay(T, "txn_1"), refund(T + DAY, "txn_1")])!;
    expect(revoked.status).toBe("revoked");
    expect(checkoutEligibility(revoked, "plus_monthly", T + 2 * DAY).ok).toBe(false); // the subscription is still live at Paddle until the cancel is confirmed
    expect(checkoutEligibility({ ...revoked, pendingCancel: null, paddleSubscriptionId: null }, "plus_monthly", T + 2 * DAY).ok).toBe(true);
  });
});

describe("subscription events", () => {
  it("adds one period per paid billing period, once, whatever event carries it", () => {
    const plan = run([sub(T), pay(T + 1000, "txn_1"), sub(T + DAY), pay(T + 2000, "txn_1")])!;
    // The first event to name the paying transaction fills it in, without adding a second period.
    expect(plan.paidPeriods).toEqual([{ start: T, end: addMonthsUTC(T, 1), kind: "subscription", purchaseId: "txn_1" }]);
  });

  it("records the paying transaction on the period when the payment event is the first to carry it", () => {
    const plan = run([pay(T, "txn_1")])!;
    expect(plan.paidPeriods).toEqual([{ start: T, end: addMonthsUTC(T, 1), kind: "subscription", purchaseId: "txn_1" }]);
  });

  it("starts no period for past_due, and starts it once the payment succeeds", () => {
    const renewal = addMonthsUTC(T, 1);
    const plan = run([sub(T), sub(renewal + 1000, { status: "past_due", periodStart: renewal, periodEnd: addMonthsUTC(T, 2) })])!;
    expect(plan.status).toBe("past_due");
    expect(plan.paidPeriods).toHaveLength(1);
    const recovered = run([sub(T), sub(renewal + 1000, { status: "past_due", periodStart: renewal, periodEnd: addMonthsUTC(T, 2) }), pay(renewal + DAY, "txn_2", { periodStart: renewal, periodEnd: addMonthsUTC(T, 2) })])!;
    expect(recovered.status).toBe("active");
    expect(recovered.paidPeriods.map((p) => p.start)).toEqual([T, renewal]);
  });

  it("sets and clears the cancel-at-period-end flag from the scheduled change, and leaves it alone when the event does not say", () => {
    let plan = run([sub(T), sub(T + DAY, { cancelAtPeriodEnd: true })])!;
    expect(plan.cancelAtPeriodEnd).toBe(true);
    plan = run([sub(T), sub(T + DAY, { cancelAtPeriodEnd: true }), sub(T + 2 * DAY, { cancelAtPeriodEnd: null })])!;
    expect(plan.cancelAtPeriodEnd).toBe(true);
    plan = run([sub(T), sub(T + DAY, { cancelAtPeriodEnd: true }), sub(T + 2 * DAY, { cancelAtPeriodEnd: false })])!;
    expect(plan.cancelAtPeriodEnd).toBe(false);
  });

  it("an immediate cancel cuts the running period; one scheduled for the period end leaves it whole", () => {
    const end = addMonthsUTC(T, 1);
    const immediate = run([sub(T), sub(T + 10 * DAY, { status: "canceled", periodStart: null, periodEnd: null })])!;
    expect(immediate.status).toBe("canceled");
    expect(immediate.paidPeriods[0]!.end).toBe(T + 10 * DAY);
    const scheduled = run([sub(T), sub(T + DAY, { cancelAtPeriodEnd: true }), sub(end, { status: "canceled", periodStart: null, periodEnd: null })])!;
    expect(scheduled.status).toBe("canceled");
    expect(scheduled.paidPeriods[0]!.end).toBe(end);
  });

  it("an unconfigured price is accepted only when the event names none; a different price is a conflict", () => {
    expect(apply(null, sub(T, { priceIds: [] })).kind).toBe("applied");
    expect(apply(null, sub(T, { priceIds: ["pri_other"] }))).toEqual({ kind: "conflict", reason: "unexpected_price" });
    expect(apply(null, sub(T, { priceIds: ["pri_m", "pri_x"] }))).toEqual({ kind: "conflict", reason: "unexpected_price" });
  });

  it("rejects a period that is empty, inverted or longer than a billing month", () => {
    expect(apply(null, sub(T, { periodEnd: T }))).toEqual({ kind: "conflict", reason: "malformed" });
    expect(apply(null, sub(T, { periodEnd: T - 1 }))).toEqual({ kind: "conflict", reason: "malformed" });
    expect(apply(null, sub(T, { periodEnd: T + 63 * DAY }))).toEqual({ kind: "conflict", reason: "malformed" });
    expect(apply(null, sub(T, { periodEnd: T + 62 * DAY })).kind).toBe("applied");
  });

  it("does not rewrite the customer id from later events of the same subscription", () => {
    const plan = run([sub(T), sub(T + DAY, { customerId: "ctm_other" })])!;
    expect(plan.paddleCustomerId).toBe("ctm_1");
  });
});

describe("semester pass", () => {
  it("makes five consecutive month windows from the payment, once per transaction", () => {
    const plan = run([pass(T, "txn_p"), pass(T + 5000, "txn_p")])!;
    expect(plan.paidPeriods).toHaveLength(5);
    expect(plan.paidPeriods[0]!.start).toBe(T);
    expect(plan.paidPeriods.map((p) => p.kind)).toEqual(Array(5).fill("pass"));
    expect(plan.paidPeriods[4]!.end).toBe(addMonthsUTC(T, 5));
  });

  it("queues the windows of a second pass after the first, however late it is bought inside the first", () => {
    for (const offset of [DAY, 40 * DAY, 100 * DAY, 149 * DAY]) {
      const plan = run([pass(T, "txn_a"), pass(T + offset, "txn_b")])!;
      expect(plan.paidPeriods).toHaveLength(10);
      expect(plan.paidPeriods[5]!.start).toBe(addMonthsUTC(T, 5));
      expect(noOverlap(plan.paidPeriods)).toBe(true);
    }
  });

  it("queues a third pass after the second", () => {
    const plan = run([pass(T, "a"), pass(T + DAY, "b"), pass(T + 2 * DAY, "c")])!;
    expect(plan.paidPeriods).toHaveLength(15);
    expect(plan.paidPeriods[14]!.end).toBe(addMonthsUTC(addMonthsUTC(addMonthsUTC(T, 5), 5), 5));
  });

  it("handles a pass bought on the last day of a month and across a leap day", () => {
    const jan31 = Date.UTC(2028, 0, 31, 12);
    const plan = run([pass(jan31, "txn_p")])!;
    expect(plan.paidPeriods.map((p) => new Date(p.start).toISOString().slice(0, 10))).toEqual(["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30", "2028-05-31"]);
    expect(new Date(plan.paidPeriods[4]!.end).toISOString().slice(0, 10)).toBe("2028-06-30");
  });

  it("is a conflict while a subscription runs, and not an event of ours when it is some other payment", () => {
    expect(apply(run([sub(T)]), pass(T + DAY, "txn_p"))).toEqual({ kind: "conflict", reason: "plan_conflict" });
    expect(apply(null, ev({ kind: "transaction", occurredAt: T, transactionId: "txn_x", priceIds: ["pri_other"] })).kind).toBe("ignored");
    expect(apply(null, pass(T, "txn_p", { transactionId: null }))).toEqual({ kind: "conflict", reason: "malformed" });
  });

  it("is allowed after a subscription ended, and forgets the old subscription id", () => {
    const ended = run([sub(T), sub(T + 5 * DAY, { status: "canceled", periodStart: null, periodEnd: null })])!;
    const plan = run([sub(T), sub(T + 5 * DAY, { status: "canceled", periodStart: null, periodEnd: null }), pass(T + 6 * DAY, "txn_p")])!;
    expect(ended.paddleSubscriptionId).toBe("sub_1");
    expect(plan).toMatchObject({ planId: "plus_semester", status: "active", paddleSubscriptionId: null });
    expect(subscriptionRunning(plan, T + 7 * DAY)).toBe(false);
  });

  it("a subscription cannot start while a pass is active", () => {
    const plan = run([pass(T, "txn_p")]);
    expect(apply(plan, sub(T + DAY, { subscriptionId: "sub_new" }))).toEqual({ kind: "conflict", reason: "plan_conflict" });
    expect(apply(plan, sub(addMonthsUTC(T, 5), { subscriptionId: "sub_new" })).kind).toBe("applied");
  });
});

describe("refunds and chargebacks", () => {
  it("revoke the periods the refunded payment bought, and not the running window another payment bought", () => {
    const plan = run([pass(T, "txn_a"), pass(T + DAY, "txn_b"), refund(T + 40 * DAY, "txn_b")])!;
    const revoked = plan.paidPeriods.filter((p) => p.revokedAt !== undefined);
    // Pass A is running at the refund, but A's payment was not refunded: only B's five windows are withdrawn.
    expect(revoked.map((p) => p.purchaseId)).toEqual(["txn_b", "txn_b", "txn_b", "txn_b", "txn_b"]);
    expect(plan.status).toBe("active");
    expect(livePeriods(plan.paidPeriods).every((p) => p.purchaseId === "txn_a")).toBe(true);
    expect(livePeriods(plan.paidPeriods)).toHaveLength(5);
  });

  it("with no payment named, revoke the running and all later periods", () => {
    const plan = run([pass(T, "txn_a"), refund(T + 40 * DAY, null)])!;
    expect(plan.status).toBe("revoked");
    expect(plan.paidPeriods.filter((p) => p.revokedAt === undefined).map((p) => p.end <= T + 40 * DAY)).toEqual([true]);
  });

  it("are idempotent: a second delivery changes nothing", () => {
    const once = run([pass(T, "txn_a"), refund(T + DAY, "txn_a")])!;
    const twice = run([pass(T, "txn_a"), refund(T + DAY, "txn_a"), refund(T + DAY, "txn_a")])!;
    expect(twice.paidPeriods).toEqual(once.paidPeriods);
    expect(apply(once, refund(T + DAY, "txn_a")).kind).toBe("ignored");
  });

  it("ask for the subscription to be canceled, once, so the renewals stop", () => {
    const plan = run([sub(T), pay(T, "txn_1"), refund(T + DAY, "txn_1")])!;
    expect(plan.pendingCancel).toEqual({ when: "now", requestedAt: T + DAY, attempts: 0, nextAttemptAt: T + DAY, alerted: false });
    expect(plan.cancelAtPeriodEnd).toBe(false);
  });

  it("do not touch the plan of a pass-free, subscription-free account, and ignore adjustments that are not refunds", () => {
    expect(apply(null, refund(T, "txn_x")).kind).toBe("ignored");
    const plan = run([pass(T, "txn_a")])!;
    for (const [action, status] of [["credit", "approved"], ["refund", "pending_approval"], ["chargeback", "reversed"], ["refund", null]] as const) {
      expect(apply(plan, refund(T + DAY, "txn_a", { action, status })).kind, `${action} ${status}`).toBe("ignored");
    }
  });
});

describe("applyConfirmedCancel", () => {
  const plan = run([sub(T)])!;

  it("at the period end sets the flag and leaves the window", () => {
    const next = applyConfirmedCancel({ ...plan, pendingCancel: { when: "period_end", requestedAt: T, attempts: 2, nextAttemptAt: T, alerted: false } }, "period_end", T + DAY);
    expect(next).toMatchObject({ cancelAtPeriodEnd: true, status: "active", pendingCancel: null });
    expect(next.paidPeriods).toEqual(plan.paidPeriods);
  });

  it("now ends the running period at that instant and applying it twice changes nothing", () => {
    const once = applyConfirmedCancel(plan, "now", T + 3 * DAY);
    expect(once).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    expect(once.paidPeriods[0]!.end).toBe(T + 3 * DAY);
    expect(applyConfirmedCancel(once, "now", T + 4 * DAY)).toEqual(once);
  });
});

describe("toPublicPlan (the contract's Plan object)", () => {
  it("shows the running period, the cancel flag and past_due", () => {
    const end = addMonthsUTC(T, 1);
    const monthly = run([sub(T), sub(T + DAY, { cancelAtPeriodEnd: true })])!;
    expect(toPublicPlan(monthly, T + 2 * DAY)).toEqual({ id: "plus_monthly", status: "active", period_start: "2026-11-01T09:30:00Z", period_end: new Date(end).toISOString().replace(".000Z", "Z"), cancel_at_period_end: true });
    const pastDue = run([sub(T), sub(T + 2 * DAY, { status: "past_due", periodStart: null, periodEnd: null })])!;
    expect(toPublicPlan(pastDue, T + 3 * DAY)).toMatchObject({ id: "plus_monthly", status: "past_due" });
    expect(toPublicPlan(pastDue, end + DAY)).toEqual({ id: "plus_monthly", status: "past_due", period_start: null, period_end: null, cancel_at_period_end: false });
  });

  it("is free with status none for an account that never paid, canceled once a plan ended, revoked after a refund", () => {
    expect(toPublicPlan(null, T)).toEqual({ id: "free", status: "none", period_start: null, period_end: null, cancel_at_period_end: false });
    const ended = run([pass(T, "txn_a")])!;
    expect(toPublicPlan(ended, addMonthsUTC(T, 5))).toMatchObject({ id: "free", status: "canceled" });
    const revoked = run([pass(T, "txn_a"), refund(T + DAY, "txn_a")])!;
    expect(toPublicPlan(revoked, T + 2 * DAY)).toEqual({ id: "plus_semester", status: "revoked", period_start: null, period_end: null, cancel_at_period_end: false });
  });

  it("starts the period inclusively and ends it exclusively", () => {
    const plan = run([pass(T, "txn_a")])!;
    expect(toPublicPlan(plan, T).id).toBe("plus_semester");
    expect(toPublicPlan(plan, addMonthsUTC(T, 1)).period_start).toBe(new Date(addMonthsUTC(T, 1)).toISOString().replace(".000Z", "Z"));
    expect(toPublicPlan(plan, T - 1).id).toBe("free");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property-style tests: a seeded generator of purchase histories, checked against the invariants of the model.
// ---------------------------------------------------------------------------------------------------------------

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

interface History {
  events: NormalizedEvent[];
  /** The longest the account could have paid for: every reported paid period, and 5 x 31 days per pass. */
  paidUpperBoundMs: number;
}

function generate(seed: number): History {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)]!;
  const events: NormalizedEvent[] = [];
  let bound = 0;
  let t = T + Math.floor(rnd() * 400) * DAY; // any start day, so month ends and leap days come up
  let n = 0;
  const steps = 4 + Math.floor(rnd() * 8);
  let subs = 0;
  let renewals = 0;
  let subStart = t;
  for (let i = 0; i < steps; i++) {
    t += Math.floor(rnd() * 70) * DAY + Math.floor(rnd() * 86_400_000);
    const kind = pick(["renew", "renew", "pass", "pass", "refund", "cancel", "pastdue", "newsub"] as const);
    n++;
    if (kind === "pass") {
      events.push(pass(t, `txn_p${n}`));
      bound += 5 * 31 * DAY;
    } else if (kind === "newsub") {
      subs++;
      renewals = 0;
      subStart = t;
      const period = { periodStart: t, periodEnd: addMonthsUTC(t, 1) };
      events.push(sub(t, { subscriptionId: `sub_${subs}`, ...period }), pay(t + 1000, `txn_s${n}`, { subscriptionId: `sub_${subs}`, ...period }));
      bound += period.periodEnd - period.periodStart;
    } else if (kind === "renew" && subs > 0) {
      renewals++;
      const period = { periodStart: addMonthsUTC(subStart, renewals), periodEnd: addMonthsUTC(subStart, renewals + 1) };
      events.push(pay(t, `txn_r${n}`, { subscriptionId: `sub_${subs}`, ...period }));
      bound += period.periodEnd - period.periodStart;
    } else if (kind === "refund") {
      events.push(refund(t, rnd() < 0.5 ? null : `txn_p${Math.max(1, n - 1)}`));
    } else if (kind === "cancel" && subs > 0) {
      events.push(sub(t, { subscriptionId: `sub_${subs}`, status: "canceled", periodStart: null, periodEnd: null }));
    } else if (kind === "pastdue" && subs > 0) {
      events.push(sub(t, { subscriptionId: `sub_${subs}`, status: "past_due", periodStart: null, periodEnd: null }));
    }
  }
  return { events, paidUpperBoundMs: bound };
}

/** Emulates the store: older than the newest applied event is applied additively. */
function runLikeTheStore(events: NormalizedEvent[]): PlanRecord | null {
  let plan = null as PlanRecord | null;
  for (const e of events) {
    const newest: number | null = plan?.lastEventAt ?? null;
    const stale = newest !== null && e.occurredAt < newest;
    const r = apply(plan, e, stale ? "additive" : "full");
    if (r.kind === "applied") plan = { ...r.plan, lastEventAt: stale ? newest : e.occurredAt };
  }
  return plan;
}

function shuffled<X>(xs: X[], seed: number): X[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("properties of the window model", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => 1000 + i);

  it("never has two live windows open at once, whatever the history and the arrival order", () => {
    for (const seed of seeds) {
      const h = generate(seed);
      for (const order of [h.events, shuffled(h.events, seed), [...h.events].reverse()]) {
        const plan = runLikeTheStore(order);
        if (plan) expect(noOverlap(plan.paidPeriods), `seed ${seed}`).toBe(true);
      }
    }
  });

  it("never grants more window time than was paid for", () => {
    for (const seed of seeds) {
      const h = generate(seed);
      for (const order of [h.events, shuffled(h.events, seed + 1)]) {
        const plan = runLikeTheStore(order);
        if (!plan) continue;
        const grantedMs = liveDays(plan.paidPeriods) * DAY;
        expect(grantedMs, `seed ${seed}`).toBeLessThanOrEqual(h.paidUpperBoundMs + 1);
      }
    }
  });

  it("is idempotent: every event delivered twice in a row (under two event ids) ends in the same plan", () => {
    // Exact redeliveries are stopped by the claim on the event id; these are the same facts under new event ids.
    for (const seed of seeds) {
      const h = generate(seed);
      const once = runLikeTheStore(h.events);
      const twice = runLikeTheStore(h.events.flatMap((e) => [e, { ...e, eventId: `${e.eventId}_again` }]));
      expect(twice?.paidPeriods, `seed ${seed}`).toEqual(once?.paidPeriods);
      expect(twice?.status, `seed ${seed}`).toBe(once?.status);
    }
  });

  it("gives passes the same total time in any arrival order (purchases are facts, not state)", () => {
    for (const seed of seeds.slice(0, 100)) {
      const rnd = mulberry32(seed);
      const count = 2 + Math.floor(rnd() * 3);
      const events = Array.from({ length: count }, (_, i) => pass(T + Math.floor(rnd() * 100) * DAY, `txn_${i}`));
      const a = runLikeTheStore(events)!;
      const b = runLikeTheStore(shuffled(events, seed))!;
      expect(a.paidPeriods.length).toBe(count * 5);
      expect(b.paidPeriods.length).toBe(count * 5);
      expect(noOverlap(a.paidPeriods) && noOverlap(b.paidPeriods)).toBe(true);
      // Contiguous from the first purchase's start: queued, never stacked.
      const sorted = [...b.paidPeriods].sort((x, y) => x.start - y.start);
      sorted.forEach((p, i) => i > 0 && expect(p.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end));
    }
  });

  it("a revoked period never comes back: replaying its purchase after the refund leaves it revoked", () => {
    for (const seed of seeds.slice(0, 100)) {
      const rnd = mulberry32(seed);
      const t = T + Math.floor(rnd() * 200) * DAY;
      const first = pass(t, "txn_p");
      const rest = [refund(t + Math.floor(rnd() * 100) * DAY, "txn_p"), pass(t + 1, "txn_p"), sub(t + DAY, { subscriptionId: "sub_z" })];
      const events = [first, ...rest];
      const plan = runLikeTheStore(events)!;
      expect(plan.paidPeriods.filter((p) => p.purchaseId === "txn_p").length, `seed ${seed}`).toBe(5);
      // Every pass window that was still running or ahead at the refund is withdrawn, in every arrival order of
      // what follows the purchase (a refund can only exist after the payment it refunds).
      for (const order of [events, [first, ...shuffled(rest, seed)]]) {
        const p2 = runLikeTheStore(order)!;
        const stillLive = livePeriods(p2.paidPeriods).filter((p) => p.purchaseId === "txn_p");
        expect(stillLive.every((p) => p.end <= events[1]!.occurredAt), `seed ${seed}`).toBe(true);
      }
    }
  });
});
