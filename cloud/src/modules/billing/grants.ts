// COMPLIMENTARY WINDOWS: GROUNDWORK FOR THE ADMIN INTERFACE (no route, no admin service here).
//
// The domain functions that docs/cloud-admin.md says the admin service calls ("the grant calls the same window
// domain function as billing"): a window with source `admin_grant`, no payment and no Paddle object, with its own
// budget, that can be shortened or revoked, composed with the plan rules:
//
//   one window per period, budgets never stack  windows never overlap; `start_policy: now` while a window is active
//                                               is refused (`window_overlap`), naming the source and the end
//   queueing                                    `after_current_windows` starts at the end of the last window whose
//                                               end is known; refused while a subscription renews on its own
//   already_subscribed                          an active grant is not an active plan (checkoutEligibility reads the
//                                               plan record, which has no grant), so a trial never blocks conversion;
//                                               a purchase cuts the grant (syncWindows), used credits stay used
//   refunds and chargebacks                     revoke only `paddle` windows (billing passes that filter); a grant
//                                               survives them
//   past_due                                    a grant is refused while a paid window is active, allowed once it ended
//   resubscribe loop / replays                  windows are keyed by their start; ensureWindow never resets usage
//
// The admin service owns what is not a window: the cap on days per account per year, the per-admin and monthly caps,
// the grant record, the audit row, the notification email and the roles. The contract ceilings below are enforced here
// because they protect the ledger whatever calls this.

import type { BudgetWindow, WindowSource } from "../../storage";
import type { BillingEnv } from "./env";
import { subscriptionRunning } from "./plan-model";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A grant is cut into windows of at most this many days; the last one is prorated. */
export const GRANT_WINDOW_DAYS = 30;
/** Ceilings of the admin contract ("never above 90 days", "never above 25,000 credits per window"). */
export const MAX_GRANT_DAYS = 90;
export const MAX_GRANT_CREDITS_PER_WINDOW = 25_000;

export interface GrantWindowSpec {
  start: number;
  end: number;
  limit: number;
}

/**
 * The windows of a grant of `days` days from `start`: whole 30-day windows and a last one for the remainder, whose
 * budget is prorated and rounded down (but is at least 1 credit). A 90-day grant is three windows.
 */
export function planGrantWindows(start: number, days: number, creditsPerWindow: number): GrantWindowSpec[] {
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) throw new RangeError("days must be a whole number from 1 to 90");
  if (!Number.isInteger(creditsPerWindow) || creditsPerWindow < 1 || creditsPerWindow > MAX_GRANT_CREDITS_PER_WINDOW) {
    throw new RangeError("credits per window must be a whole number from 1 to 25000");
  }
  const windows: GrantWindowSpec[] = [];
  for (let first = 0; first < days; first += GRANT_WINDOW_DAYS) {
    const length = Math.min(GRANT_WINDOW_DAYS, days - first);
    windows.push({
      start: start + first * DAY_MS,
      end: start + (first + length) * DAY_MS,
      limit: length === GRANT_WINDOW_DAYS ? creditsPerWindow : Math.max(1, Math.floor((creditsPerWindow * length) / GRANT_WINDOW_DAYS)),
    });
  }
  return windows;
}

export interface GrantRequest {
  /** The admin service's grant id; stored on every window so shorten and revoke find them. */
  grantId: string;
  days: number;
  /** Defaults to the standard Plus window budget. */
  creditsPerWindow?: number;
  startPolicy: "now" | "after_current_windows";
}

export type GrantOutcome =
  | { ok: true; startsAt: number; endsAt: number; windows: BudgetWindow[] }
  /** The conflicting window's source and end (null: a subscription that renews on its own has no known end). */
  | { ok: false; reason: "window_overlap"; conflict: { source: WindowSource; end: number | null } }
  /** A window of this account already uses that exact start (a revoked one): try again a moment later. */
  | { ok: false; reason: "start_taken" };

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start < b.end && a.end > b.start;

/**
 * Creates the windows of a grant. Idempotent for the same request at the same instant (a replay finds its own
 * windows and returns them, creating none and resetting nothing). Bumps the plan version so the app refetches.
 */
export async function createGrantWindows(env: BillingEnv, accountId: string, request: GrantRequest): Promise<GrantOutcome> {
  const { ledger, accounts } = env.stores;
  const now = env.clock.now();
  const credits = request.creditsPerWindow ?? env.settings.windowCredits.plus_monthly;
  const live = (await ledger.listWindows(accountId)).filter((w) => w.revokedAt === null && w.end > now && w.grantId !== request.grantId);

  let start = now;
  if (request.startPolicy === "after_current_windows") {
    const plan = await accounts.getPlan(accountId);
    // A subscription that renews by itself has no known end to queue behind.
    if (subscriptionRunning(plan, now) && !plan?.cancelAtPeriodEnd) {
      return { ok: false, reason: "window_overlap", conflict: { source: "paddle", end: null } };
    }
    for (const w of live) start = Math.max(start, w.end);
  }

  const specs = planGrantWindows(start, request.days, credits);
  const range = { start: specs[0]!.start, end: specs[specs.length - 1]!.end };
  const conflict = live.find((w) => overlaps(w, range));
  if (conflict) return { ok: false, reason: "window_overlap", conflict: { source: conflict.source, end: conflict.end } };

  const windows: BudgetWindow[] = [];
  for (const spec of specs) {
    const w = await ledger.ensureWindow(accountId, { ...spec, source: "admin_grant", grantId: request.grantId });
    if (w.grantId !== request.grantId || w.source !== "admin_grant") return { ok: false, reason: "start_taken" };
    windows.push(w);
  }
  await accounts.touchPlanVersion(accountId);
  return { ok: true, startsAt: range.start, endsAt: range.end, windows };
}

/**
 * Moves the end of a grant earlier, never later (a longer period is a new grant and passes the caps again). Windows
 * after the new end are removed, the window that contains it is cut, and used credits stay used. Returns how many
 * windows changed; `not_earlier` when `newEnd` is not before the grant's current end.
 */
export async function shortenGrantWindows(
  env: BillingEnv,
  accountId: string,
  grantId: string,
  newEnd: number,
): Promise<{ ok: true; changed: number } | { ok: false; reason: "not_found" | "not_earlier" }> {
  const { ledger, accounts } = env.stores;
  const windows = (await ledger.listWindows(accountId)).filter((w) => w.grantId === grantId && w.source === "admin_grant" && w.revokedAt === null);
  if (windows.length === 0) return { ok: false, reason: "not_found" };
  const currentEnd = Math.max(...windows.map((w) => w.end));
  if (!(newEnd < currentEnd)) return { ok: false, reason: "not_earlier" };
  const changed = await ledger.truncateWindows(accountId, newEnd, { source: "admin_grant", grantId });
  if (changed > 0) await accounts.touchPlanVersion(accountId);
  return { ok: true, changed };
}

/**
 * Ends all of the grant's windows now: the remaining credits become unusable on the next request. Windows that
 * already ended stay as history; used credits stay used. Only this grant's windows are touched.
 */
export async function revokeGrantWindows(env: BillingEnv, accountId: string, grantId: string): Promise<{ changed: number }> {
  const { ledger, accounts } = env.stores;
  const changed = await ledger.revokeWindows(accountId, env.clock.now(), { source: "admin_grant", grantId });
  if (changed > 0) await accounts.touchPlanVersion(accountId);
  return { changed };
}
