import { describe, expect, it } from "vitest";
import type { PaidPeriod } from "../../storage";
import { addMonthsUTC, consecutiveMonths, insertPeriod, lastEnd, liveDays, noOverlap, periodAt, truncatePeriods } from "./windows";

const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number => Date.UTC(y, m - 1, d, h, mi, s, ms);
const day = 24 * 60 * 60 * 1000;

describe("addMonthsUTC", () => {
  it("adds calendar months and keeps the time of day", () => {
    expect(addMonthsUTC(utc(2026, 11, 1, 9, 30), 1)).toBe(utc(2026, 12, 1, 9, 30));
    expect(addMonthsUTC(utc(2026, 11, 15, 23, 59, 59, 999), 3)).toBe(utc(2027, 2, 15, 23, 59, 59, 999));
  });

  it("clamps a day that does not exist in the target month (month ends)", () => {
    expect(addMonthsUTC(utc(2026, 1, 31), 1)).toBe(utc(2026, 2, 28));
    expect(addMonthsUTC(utc(2026, 3, 31), 1)).toBe(utc(2026, 4, 30));
    expect(addMonthsUTC(utc(2026, 8, 31), 1)).toBe(utc(2026, 9, 30));
    expect(addMonthsUTC(utc(2026, 12, 31), 2)).toBe(utc(2027, 2, 28));
  });

  it("handles leap days: 29 February and the February of a leap year", () => {
    expect(addMonthsUTC(utc(2028, 1, 31), 1)).toBe(utc(2028, 2, 29)); // 2028 is a leap year
    expect(addMonthsUTC(utc(2028, 2, 29), 12)).toBe(utc(2029, 2, 28)); // the leap day does not exist next year
    expect(addMonthsUTC(utc(2028, 2, 29), 48)).toBe(utc(2032, 2, 29));
    expect(addMonthsUTC(utc(2100, 1, 31), 1)).toBe(utc(2100, 2, 28)); // 2100 is not a leap year
    expect(addMonthsUTC(utc(2000, 1, 31), 1)).toBe(utc(2000, 2, 29)); // 2000 is
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonthsUTC(utc(2026, 12, 15), 1)).toBe(utc(2027, 1, 15));
    expect(addMonthsUTC(utc(2026, 1, 15), -1)).toBe(utc(2025, 12, 15));
    expect(addMonthsUTC(utc(2026, 1, 31), -2)).toBe(utc(2025, 11, 30));
    expect(addMonthsUTC(utc(2026, 6, 10), 0)).toBe(utc(2026, 6, 10));
  });

  it("rejects a fractional month count", () => {
    expect(() => addMonthsUTC(0, 1.5)).toThrow(RangeError);
  });

  it("does not depend on the host time zone or daylight saving", () => {
    const original = process.env.TZ;
    try {
      const results = new Set<string>();
      for (const tz of ["UTC", "Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata", "Europe/Paris"]) {
        process.env.TZ = tz;
        // Anchors around the DST changes of several zones, and the leap day.
        const out = [utc(2026, 3, 29, 1, 30), utc(2026, 10, 25, 0, 30), utc(2026, 4, 5, 14), utc(2028, 2, 29, 12), utc(2026, 1, 31, 23, 59)].map((a) =>
          consecutiveMonths(a, 5).map((w) => `${w.start}-${w.end}`).join("|"),
        );
        results.add(out.join("#"));
      }
      expect(results.size).toBe(1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("consecutiveMonths", () => {
  it("makes contiguous windows that end exactly where the next begins", () => {
    for (const anchor of [utc(2026, 11, 1, 9, 30), utc(2026, 1, 31), utc(2028, 2, 29), utc(2026, 8, 31, 23, 59, 59)]) {
      const windows = consecutiveMonths(anchor, 5);
      expect(windows).toHaveLength(5);
      expect(windows[0]!.start).toBe(anchor);
      windows.forEach((w, i) => {
        expect(w.end).toBeGreaterThan(w.start);
        if (i > 0) expect(w.start).toBe(windows[i - 1]!.end);
      });
    }
  });

  it("computes every boundary from the anchor, so a clamped month does not drift the later ones", () => {
    const w = consecutiveMonths(utc(2026, 1, 31), 5);
    expect(w.map((x) => x.start)).toEqual([utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31), utc(2026, 4, 30), utc(2026, 5, 31)]);
    expect(w[4]!.end).toBe(utc(2026, 6, 30));
  });

  it("a semester starting on 1 November ends on 1 April, windows of 30, 31, 31, 28 and 31 days", () => {
    const w = consecutiveMonths(utc(2026, 11, 1), 5);
    expect(w.map((x) => (x.end - x.start) / day)).toEqual([30, 31, 31, 28, 31]);
    expect(w[4]!.end).toBe(utc(2027, 4, 1));
  });
});

describe("insertPeriod", () => {
  const p = (start: number, end: number, extra: Partial<PaidPeriod> = {}): PaidPeriod => ({ start, end, kind: "subscription", ...extra });

  it("adds a period once: the same start is the same period (a replay adds nothing)", () => {
    const first = insertPeriod([], p(0, 10 * day));
    expect(first.added).toEqual(p(0, 10 * day));
    const again = insertPeriod(first.periods, p(0, 10 * day));
    expect(again.added).toBeNull();
    expect(again.periods).toEqual(first.periods);
  });

  it("never revives a revoked period: its start is still taken", () => {
    const revoked = [p(0, 10 * day, { revokedAt: 5 * day })];
    expect(insertPeriod(revoked, p(0, 10 * day)).added).toBeNull();
  });

  it("clips the start of a period that begins before the live one ends, so windows never overlap", () => {
    const live = [p(0, 30 * day)];
    const r = insertPeriod(live, p(29 * day, 60 * day));
    expect(r.added).toEqual(p(30 * day, 60 * day));
    expect(noOverlap(r.periods)).toBe(true);
  });

  it("drops a period that lies wholly inside a live one", () => {
    expect(insertPeriod([p(0, 30 * day)], p(5 * day, 20 * day)).added).toBeNull();
    expect(insertPeriod([p(0, 30 * day)], p(0 + 1, 30 * day)).added).toBeNull();
  });

  it("keeps only the part before a later live period (a late event for an earlier month)", () => {
    const r = insertPeriod([p(28 * day, 59 * day)], p(0, 31 * day));
    expect(r.added).toEqual(p(0, 28 * day));
    expect(noOverlap(r.periods)).toBe(true);
  });

  it("ignores an empty or inverted period", () => {
    expect(insertPeriod([], p(5, 5)).added).toBeNull();
    expect(insertPeriod([], p(9, 5)).added).toBeNull();
  });

  it("ignores revoked periods when checking for overlap: they buy nothing", () => {
    const r = insertPeriod([p(0, 30 * day, { revokedAt: day })], p(10 * day, 40 * day));
    expect(r.added).toEqual(p(10 * day, 40 * day));
  });
});

describe("truncatePeriods and lookups", () => {
  const periods: PaidPeriod[] = [
    { start: 0, end: 30 * day, kind: "subscription" },
    { start: 30 * day, end: 60 * day, kind: "subscription" },
    { start: 60 * day, end: 90 * day, kind: "pass" },
  ];

  it("cuts the running period, revokes later ones and leaves earlier ones", () => {
    const out = truncatePeriods(periods, 40 * day);
    expect(out[0]).toEqual(periods[0]);
    expect(out[1]).toEqual({ start: 30 * day, end: 40 * day, kind: "subscription" });
    expect(out[2]).toEqual({ ...periods[2], revokedAt: 40 * day });
  });

  it("can be limited to one kind, and a period starting exactly at the instant is revoked", () => {
    const out = truncatePeriods(periods, 30 * day, "subscription");
    expect(out[1]).toEqual({ ...periods[1], revokedAt: 30 * day });
    expect(out[2]).toEqual(periods[2]);
  });

  it("finds the period at an instant (start inclusive, end exclusive) and the last end", () => {
    expect(periodAt(periods, 0)).toBe(periods[0]);
    expect(periodAt(periods, 30 * day - 1)).toBe(periods[0]);
    expect(periodAt(periods, 30 * day)).toBe(periods[1]);
    expect(periodAt(periods, 90 * day)).toBeUndefined();
    expect(lastEnd(periods)).toBe(90 * day);
    expect(lastEnd(periods, "subscription")).toBe(60 * day);
    expect(liveDays(periods)).toBe(90);
  });
});
