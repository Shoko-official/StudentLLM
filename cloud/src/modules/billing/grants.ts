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
// the grant record, the audit row, the notification email and the roles. The ceilings below are enforced here because
// they protect the ledger whatever calls this. They derive from W, the standard Plus window budget
// (`windowCredits.plus_monthly`): a grant totals at most 3W and no window of it exceeds W, so a grant can never cost
// more than three standard months. The account must exist and be active.
//
// Atomicity and replay: the windows of a grant go in through one conditional insert of the ledger (all or none, rejecting
// any overlap with a window that is not revoked, live or queued), so two parallel grants cannot both take the same
// time. The caller persists `startsAt` from the first answer and passes it back on a replay; and if windows of the
// grant already exist they are returned unchanged, so a replay creates nothing and resets nothing.

import type { BudgetWindow, WindowSource } from "../../storage";
import type { BillingEnv } from "./env";
import { subscriptionRunning } from "./plan-model";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A grant is cut into windows of at most this many days; the last one is prorated. */
export const GRANT_WINDOW_DAYS = 30;
/** Ceiling of the admin contract ("never above 90 days"), that is three windows. */
export const MAX_GRANT_DAYS = 90;
/** A grant totals at most this many standard windows. */
export const MAX_GRANT_WINDOWS_TOTAL = 3;

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
  if (!Number.isInteger(creditsPerWindow) || creditsPerWindow < 1) throw new RangeError("credits per window must be a whole positive number");
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
  /** Defaults to W; never above W. */
  creditsPerWindow?: number;
  startPolicy: "now" | "after_current_windows";
  /**
   * The start the caller persisted from the first answer. When given it is used as is (the policy is not recomputed),
   * so a replay after a crash asks for the same time and finds the same windows.
   */
  startsAt?: number;
}

export type GrantOutcome =
  | { ok: true; startsAt: number; endsAt: number; windows: BudgetWindow[]; existed: boolean }
  /** The conflicting window's source and end (null: a subscription that renews on its own has no known end). */
  | { ok: false; reason: "window_overlap"; conflict: { source: WindowSource; end: number | null } }
  /** A window of this account already uses that exact start (a revoked one): try again a moment later. */
  | { ok: false; reason: "start_taken" }
  | { ok: false; reason: "limit_exceeded"; limit: "grant_max_credits_per_window" | "grant_max_total_credits" }
  /** The account does not exist, is suspended or is being deleted. */
  | { ok: false; reason: "account_not_active" };

/**
 * Creates the windows of a grant, atomically and idempotently (see the header). Bumps the plan version so the app
 * refetches. Throws RangeError for a request that is malformed (days outside 1 to 90, a non-integer budget).
 */
export async function createGrantWindows(env: BillingEnv, accountId: string, request: GrantRequest): Promise<GrantOutcome> {
  const { ledger, accounts } = env.stores;
  const account = await accounts.getById(accountId);
  if (!account || account.status !== "active") return { ok: false, reason: "account_not_active" };

  const standard = env.settings.windowCredits.plus_monthly;
  const credits = request.creditsPerWindow ?? standard;
  if (credits > standard) return { ok: false, reason: "limit_exceeded", limit: "grant_max_credits_per_window" };

  // A replay: the grant's windows are already there. Nothing is recomputed, created or reset.
  const existing = (await ledger.listWindows(accountId)).filter((w) => w.source === "admin_grant" && w.grantId === request.grantId && w.revokedAt === null);
  if (existing.length > 0) {
    return { ok: true, startsAt: existing[0]!.start, endsAt: Math.max(...existing.map((w) => w.end)), windows: existing, existed: true };
  }

  const now = env.clock.now();
  let start = request.startsAt ?? now;
  if (request.startsAt === undefined && request.startPolicy === "after_current_windows") {
    const plan = await accounts.getPlan(accountId);
    // A subscription that renews by itself has no known end to queue behind.
    if (subscriptionRunning(plan, now) && !plan?.cancelAtPeriodEnd) {
      return { ok: false, reason: "window_overlap", conflict: { source: "paddle", end: null } };
    }
    for (const w of await ledger.listWindows(accountId)) if (w.revokedAt === null && w.end > start) start = w.end;
  }

  const specs = planGrantWindows(start, request.days, credits);
  if (specs.reduce((sum, w) => sum + w.limit, 0) > MAX_GRANT_WINDOWS_TOTAL * standard) {
    return { ok: false, reason: "limit_exceeded", limit: "grant_max_total_credits" };
  }

  const inserted = await ledger.insertGrantWindows(accountId, request.grantId, specs);
  if (!inserted.ok) {
    return inserted.reason === "overlap"
      ? { ok: false, reason: "window_overlap", conflict: { source: inserted.conflict.source, end: inserted.conflict.end } }
      : { ok: false, reason: "start_taken" };
  }
  if (!inserted.existed) await accounts.touchPlanVersion(accountId);
  return {
    ok: true,
    startsAt: inserted.windows[0]!.start,
    endsAt: Math.max(...inserted.windows.map((w) => w.end)),
    windows: inserted.windows,
    existed: inserted.existed,
  };
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
