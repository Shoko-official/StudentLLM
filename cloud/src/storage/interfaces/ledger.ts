// LedgerStore: credit windows, reservations, settlement. Plan row: "Usage" (and the windows of "Plan").
//
// All state is per account, so every method takes `accountId` first and an adapter routes the call to
// that account's Durable Object. A reservation remembers the idempotency key it belongs to, so settling,
// releasing or sweeping it moves the idempotency record in the SAME call (one atomic step): the two can
// never disagree, even if the process dies between them.
//
// Reconciliation (the plan's "reconciler") is per account: `sweep(accountId, now)`.
// - Durable Object: set an alarm at the earliest `expiresAt` of the account's open reservations; the
//   alarm handler calls `sweep(ownAccountId, now)` and re-arms the alarm with `nextDueAt`.
// - Cron safety net: the Worker `scheduled` handler asks `SweepRegistry.due(now, limit)` which accounts have
//   reservations that may be expired and calls `sweep` for each through that account's object.
// Nothing sweeps all accounts at once.

import type { Feature } from "./common";

export type ReservationState = "reserved" | "settled" | "released";

/** The idempotency record a reservation belongs to (the account is the reservation's own account). */
export interface IdempotencyRef {
  route: string;
  /** SHA-256 of the client's key. */
  keyHash: string;
}

/**
 * Where a window comes from. Only `paddle` windows are touched by refunds and chargebacks; an `admin_grant`
 * window (a complimentary period, no payment) is touched only by the grant operations.
 */
export type WindowSource = "paddle" | "admin_grant";

/** Narrows a window operation to one source or one grant. */
export interface WindowFilter {
  source?: WindowSource;
  grantId?: string;
}

export interface BudgetWindow {
  accountId: string;
  /** Windows are keyed by their start. */
  start: number;
  source: WindowSource;
  /** The grant a complimentary window belongs to; null for a paid window. */
  grantId: string | null;
  end: number;
  limit: number;
  used: number;
  reserved: number;
  byFeature: Record<Feature, number>;
  requests: number;
  revokedAt: number | null;
}

export interface Reservation {
  requestId: string;
  accountId: string;
  windowStart: number;
  feature: Feature;
  credits: number;
  state: ReservationState;
  /** True once the request was sent upstream; an expired forwarded reservation settles at the full amount. */
  forwarded: boolean;
  /** The idempotency record to move together with this reservation, or null for a request without a key. */
  idempotency: IdempotencyRef | null;
  createdAt: number;
  expiresAt: number;
}

/** Settled request ledger row: request id, feature, logical model id, credits, time. No content. */
export interface LedgerEntry {
  requestId: string;
  accountId: string;
  feature: Feature;
  logicalModelId: string;
  credits: number;
  settledAt: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation; remaining: number; resetsAt: number }
  | { ok: false; reason: "no_window" }
  | { ok: false; reason: "budget_exhausted"; remaining: number; resetsAt: number }
  | { ok: false; reason: "duplicate_request" };

export type SettleResult =
  | { settled: true; charged: number; entry: LedgerEntry }
  | { settled: false; reason: "duplicate" | "released" | "unknown" };

export interface SweepResult {
  /** Forwarded reservations with an unknown outcome, settled at the full reservation. */
  settled: number;
  /** Never-forwarded reservations, released with zero charge. */
  released: number;
  /** Earliest expiry among the account's remaining open reservations, or null when none is left. */
  nextDueAt: number | null;
}

export interface LedgerStore {
  /**
   * Creates the window when missing. Never resets `used` or `reserved` of an existing one, never changes its
   * limit, end or source, and never un-revokes it (replaying a purchase after a refund buys nothing).
   * `source` defaults to `paddle`.
   */
  ensureWindow(
    accountId: string,
    input: { start: number; end: number; limit: number; source?: WindowSource; grantId?: string },
  ): Promise<BudgetWindow>;
  getCurrentWindow(accountId: string, now: number): Promise<BudgetWindow | null>;
  listWindows(accountId: string): Promise<BudgetWindow[]>;
  /**
   * Refund or chargeback: revokes the current and all future windows (those ending after `now`). With a
   * filter, only the windows of that source (billing passes `paddle`) or grant. Returns how many changed.
   */
  revokeWindows(accountId: string, now: number, filter?: WindowFilter): Promise<number>;
  /**
   * Ends windows at `at`: a window that contains `at` is cut there (its used credits stay used), a window
   * that starts at or after `at` is revoked. Nothing moves later, and a window that ended at or before `at`
   * is untouched. Used for an immediate cancellation, a grant cut by a purchase and a shortened grant.
   * Returns how many windows changed.
   */
  truncateWindows(accountId: string, at: number, filter?: WindowFilter): Promise<number>;

  /** Atomic: checks the remaining budget of the current window and reserves `credits` (a positive integer). */
  reserve(
    accountId: string,
    input: {
      requestId: string;
      feature: Feature;
      credits: number;
      now: number;
      expiresAt: number;
      idempotency: IdempotencyRef | null;
    },
  ): Promise<ReserveResult>;
  getReservation(accountId: string, requestId: string): Promise<Reservation | null>;
  markForwarded(accountId: string, requestId: string): Promise<boolean>;
  /** Heartbeat for a stream that is making progress. */
  extendReservation(accountId: string, requestId: string, expiresAt: number): Promise<boolean>;
  /**
   * The first settlement wins; later ones are ignored and counted. The charge is capped at the
   * reservation, because `max_tokens` is clamped before the reservation is made. Moves the idempotency
   * record to `settled` (with the charge) in the same step.
   */
  settle(
    accountId: string,
    input: { requestId: string; credits: number; logicalModelId: string; now: number },
  ): Promise<SettleResult>;
  /**
   * `failed_no_usage`: releases the reservation with zero charge and moves the idempotency record to
   * `failed_no_usage` in the same step.
   */
  release(accountId: string, requestId: string, now: number): Promise<boolean>;
  /**
   * `failed_before_forward`: keeps the reservation (a same-key retry reuses it) and moves the idempotency
   * record to `failed_before_forward`.
   */
  markFailedBeforeForward(accountId: string, requestId: string, now: number): Promise<boolean>;
  /**
   * Reconciles this account's expired reservations: forwarded ones settle at the full reservation (an
   * unknown outcome must never be free usage), never-forwarded ones are released. Idempotency records move
   * in the same step. Safe to call at any time and repeatedly.
   */
  sweep(accountId: string, now: number): Promise<SweepResult>;
  getLedgerEntry(accountId: string, requestId: string): Promise<LedgerEntry | null>;
  /** Double-settlement attempts that were ignored (a counter, never content). */
  doubleSettlementCount(accountId: string): Promise<number>;
  /** Deletes this account's ledger rows settled before `beforeMs` (rows live 24 hours; window totals keep the sums). */
  pruneLedger(accountId: string, beforeMs: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

/**
 * The explicit source of "which accounts need a sweep". `LedgerStore.reserve` and `extendReservation`
 * schedule the account at the reservation's expiry and `sweep` clears or re-schedules it, in the same step.
 * The cron `scheduled` handler reads `due`; it never scans accounts.
 */
export interface SweepRegistry {
  /** Keeps the earliest due time per account. */
  schedule(accountId: string, atMs: number): Promise<void>;
  /** Replaces the due time (used after a sweep); `null` removes the account. */
  reschedule(accountId: string, atMs: number | null): Promise<void>;
  clear(accountId: string): Promise<void>;
  /** Accounts whose due time has passed, earliest first, at most `limit`. */
  due(now: number, limit: number): Promise<string[]>;
}
