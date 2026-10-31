import { describe, expect, it } from "vitest";
import type { PlanRecord } from "../../storage";
import { addMonthsUtc, planWindow } from "./window";

const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const plan = (paidPeriods: PlanRecord["paidPeriods"], status: PlanRecord["status"] = "active"): PlanRecord => ({
  accountId: "a",
  planId: "plus_monthly",
  status,
  paidPeriods,
  cancelAtPeriodEnd: false,
  paddleCustomerId: null,
  paddleSubscriptionId: null,
  lastEventAt: null,
});

describe("addMonthsUtc", () => {
  it("keeps the day and clamps to the end of a shorter month", () => {
    expect(addMonthsUtc(D(2026, 11, 15), 1)).toBe(D(2026, 12, 15));
    expect(addMonthsUtc(D(2026, 1, 31), 1)).toBe(D(2026, 2, 28));
    expect(addMonthsUtc(D(2028, 1, 31), 1)).toBe(D(2028, 2, 29));
    expect(addMonthsUtc(D(2026, 11, 30), 3)).toBe(D(2027, 2, 28));
    expect(addMonthsUtc(D(2026, 12, 1, 9), 1)).toBe(D(2027, 1, 1, 9));
    expect(addMonthsUtc(D(2026, 5, 10), 0)).toBe(D(2026, 5, 10));
  });
});

describe("planWindow", () => {
  it("is the paid period of a monthly subscription", () => {
    const p = plan([{ start: D(2026, 11, 1), end: D(2026, 12, 1) }]);
    expect(planWindow(p, D(2026, 11, 20), 15000)).toEqual({ start: D(2026, 11, 1), end: D(2026, 12, 1), limit: 15000 });
    expect(planWindow(p, D(2026, 11, 1), 15000)!.start).toBe(D(2026, 11, 1));
    expect(planWindow(p, D(2026, 12, 1), 15000)).toBeNull(); // the end is exclusive
    expect(planWindow(p, D(2026, 10, 31), 15000)).toBeNull();
  });

  it("splits a semester pass into five windows of one month, budgets never stacking", () => {
    const p = plan([{ start: D(2026, 11, 15), end: D(2027, 4, 15) }]);
    const at = [D(2026, 11, 20), D(2027, 1, 1), D(2027, 2, 1), D(2027, 3, 1), D(2027, 4, 1)];
    expect(at.map((t) => planWindow(p, t, 100)!).map((w) => [w.start, w.end])).toEqual([
      [D(2026, 11, 15), D(2026, 12, 15)],
      [D(2026, 12, 15), D(2027, 1, 15)],
      [D(2027, 1, 15), D(2027, 2, 15)],
      [D(2027, 2, 15), D(2027, 3, 15)],
      [D(2027, 3, 15), D(2027, 4, 15)],
    ]);
    // Every instant of the pass is in exactly one window, and consecutive windows touch.
    const starts = new Set<number>();
    for (let t = D(2026, 11, 15); t < D(2027, 4, 15); t += 36 * 3_600_000) starts.add(planWindow(p, t, 1)!.start);
    expect([...starts]).toHaveLength(5);
  });

  it("tolerates a billing period that ends a few seconds off the calendar month", () => {
    const p = plan([{ start: D(2026, 11, 1), end: D(2026, 12, 1) + 5000 }]);
    expect(planWindow(p, D(2026, 11, 30), 1)).toEqual({ start: D(2026, 11, 1), end: D(2026, 12, 1) + 5000, limit: 1 }); // one window, not a second tiny one
  });

  it("picks the period that covers now among several (a pass queued after a pass)", () => {
    const p = plan([
      { start: D(2026, 11, 1), end: D(2027, 4, 1) },
      { start: D(2027, 4, 1), end: D(2027, 9, 1) },
    ]);
    expect(planWindow(p, D(2027, 6, 5), 7)).toEqual({ start: D(2027, 6, 1), end: D(2027, 7, 1), limit: 7 });
  });

  it("ignores a paid period the billing module marked revoked", () => {
    const revoked = { start: D(2026, 11, 1), end: D(2026, 12, 1), revokedAt: D(2026, 11, 10) } as PlanRecord["paidPeriods"][number];
    expect(planWindow(plan([revoked]), D(2026, 11, 20), 1)).toBeNull();
  });

  it("is null for a free account, a revoked plan or no covering period", () => {
    expect(planWindow(null, D(2026, 11, 20), 1)).toBeNull();
    expect(planWindow(plan([{ start: D(2026, 11, 1), end: D(2026, 12, 1) }], "revoked"), D(2026, 11, 20), 1)).toBeNull();
    expect(planWindow(plan([{ start: D(2026, 11, 1), end: D(2026, 12, 1) }], "none"), D(2026, 11, 20), 1)).toBeNull();
    expect(planWindow(plan([]), D(2026, 11, 20), 1)).toBeNull();
  });

  it("keeps the current window of a plan that is past due or set to lapse", () => {
    const period = [{ start: D(2026, 11, 1), end: D(2026, 12, 1) }];
    expect(planWindow(plan(period, "past_due"), D(2026, 11, 20), 1)).not.toBeNull();
    expect(planWindow(plan(period, "canceled"), D(2026, 11, 20), 1)).not.toBeNull();
  });
});
