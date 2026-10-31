// Pure date and period arithmetic of the plan model. Every instant is an epoch-millisecond UTC value, so
// nothing here depends on the host time zone or on daylight saving.

import type { PaidPeriod } from "../../storage";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysInMonthUTC(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Adds calendar months in UTC and keeps the time of day. A day that does not exist in the target month is
 * clamped to its last day (31 January + 1 month = 28 February, or 29 in a leap year). Always compute the n-th
 * boundary from the anchor (`addMonthsUTC(anchor, n)`), never by adding one month to the previous boundary,
 * so a clamped month does not drift the later boundaries (31 January, 28 February, 31 March, ...).
 */
export function addMonthsUTC(ms: number, months: number): number {
  if (!Number.isInteger(months)) throw new RangeError("months must be a whole number");
  const d = new Date(ms);
  const index = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonthUTC(year, month));
  return Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** `count` consecutive one-month periods from `anchor`, each ending exactly where the next begins. */
export function consecutiveMonths(anchor: number, count: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < count; i++) out.push({ start: addMonthsUTC(anchor, i), end: addMonthsUTC(anchor, i + 1) });
  return out;
}

export const isLive = (p: PaidPeriod): boolean => p.revokedAt === undefined;

export function contains(p: PaidPeriod, at: number): boolean {
  return p.start <= at && at < p.end;
}

export function kindOf(p: PaidPeriod): "subscription" | "pass" {
  return p.kind ?? "subscription";
}

/** Periods that still buy something: not revoked. */
export function livePeriods(periods: readonly PaidPeriod[]): PaidPeriod[] {
  return periods.filter(isLive);
}

/** The non-revoked period that contains `at`, if any. */
export function periodAt(periods: readonly PaidPeriod[], at: number): PaidPeriod | undefined {
  return periods.find((p) => isLive(p) && contains(p, at));
}

/** The latest end among non-revoked periods (optionally of one kind), or null. */
export function lastEnd(periods: readonly PaidPeriod[], kind?: "subscription" | "pass"): number | null {
  let end: number | null = null;
  for (const p of periods) {
    if (!isLive(p) || (kind !== undefined && kindOf(p) !== kind)) continue;
    if (end === null || p.end > end) end = p.end;
  }
  return end;
}

/** True when a non-revoked period of this kind ends after `at` (it is running or queued). */
export function hasPeriodAfter(periods: readonly PaidPeriod[], kind: "subscription" | "pass", at: number): boolean {
  return periods.some((p) => isLive(p) && kindOf(p) === kind && p.end > at);
}

export function hasPurchase(periods: readonly PaidPeriod[], purchaseId: string): boolean {
  return periods.some((p) => p.purchaseId === purchaseId);
}

function byStart(a: PaidPeriod, b: PaidPeriod): number {
  return a.start - b.start;
}

/**
 * Adds a period without ever overlapping a live one, and idempotently.
 * - A period with a start that already exists (live or revoked) is the same period: nothing is added, so a
 *   replay never creates a second window and never resurrects a revoked one.
 * - A period that overlaps a live one is clipped to begin where the live one ends, or dropped when it lies
 *   wholly inside it, so two windows can never be open at once and budgets never stack.
 */
export function insertPeriod(
  periods: readonly PaidPeriod[],
  candidate: PaidPeriod,
): { periods: PaidPeriod[]; added: PaidPeriod | null; backfilled: PaidPeriod | null } {
  if (!(candidate.end > candidate.start)) return { periods: [...periods], added: null, backfilled: null };
  const same = periods.find((p) => p.start === candidate.start);
  if (same) {
    // The same period seen again. If this event is the first to name the payment that bought it, remember the
    // payment: a later refund finds the period by it.
    if (candidate.purchaseId !== undefined && same.purchaseId === undefined) {
      const filled = { ...same, purchaseId: candidate.purchaseId };
      return { periods: periods.map((p) => (p === same ? filled : p)), added: null, backfilled: filled };
    }
    return { periods: [...periods], added: null, backfilled: null };
  }
  let start = candidate.start;
  const live = livePeriods(periods).sort(byStart);
  for (const p of live) {
    if (candidate.end <= p.start || start >= p.end) continue;
    if (candidate.end <= p.end && start >= p.start) return { periods: [...periods], added: null, backfilled: null };
    if (start < p.start) {
      // The candidate begins before a live period and runs into it: keep only the part before it.
      return finishInsert(periods, { ...candidate, start, end: p.start });
    }
    start = p.end;
  }
  if (!(candidate.end > start)) return { periods: [...periods], added: null, backfilled: null };
  return finishInsert(periods, { ...candidate, start });
}

function finishInsert(
  periods: readonly PaidPeriod[],
  p: PaidPeriod,
): { periods: PaidPeriod[]; added: PaidPeriod | null; backfilled: PaidPeriod | null } {
  if (periods.some((q) => q.start === p.start) || !(p.end > p.start)) return { periods: [...periods], added: null, backfilled: null };
  return { periods: [...periods, p].sort(byStart), added: p, backfilled: null };
}

/** Marks every live period that ends after `at` as ended at `at`: a running one is cut, a later one is revoked. */
export function truncatePeriods(periods: readonly PaidPeriod[], at: number, kind?: "subscription" | "pass"): PaidPeriod[] {
  return periods.map((p) => {
    if (!isLive(p) || p.end <= at || (kind !== undefined && kindOf(p) !== kind)) return p;
    return p.start >= at ? { ...p, revokedAt: at } : { ...p, end: at };
  });
}

/** Sum of the lengths of the live periods, in days (used by the invariants of the tests). */
export function liveDays(periods: readonly PaidPeriod[]): number {
  return livePeriods(periods).reduce((sum, p) => sum + (p.end - p.start) / MS_PER_DAY, 0);
}

/** True when no two live periods overlap. */
export function noOverlap(periods: readonly PaidPeriod[]): boolean {
  const live = livePeriods(periods).sort(byStart);
  for (let i = 1; i < live.length; i++) if (live[i]!.start < live[i - 1]!.end) return false;
  return true;
}
