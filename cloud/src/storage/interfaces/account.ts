// AccountStore. Plan rows: "Account", "Plan", "Deletion tombstone".

import type { LoginMethod } from "./common";

export type AccountStatus = "active" | "suspended" | "deleting";
export type PlanId = "free" | "plus_monthly" | "plus_semester";
export type PlanStatus = "none" | "active" | "past_due" | "canceled" | "revoked";

export interface AccountRecord {
  /** Random opaque id, the key for everything. */
  accountId: string;
  /** The single verified sign-in email, lower case, stored in clear because the service sends mail to it. */
  email: string;
  /** Google subject id, only while Google is linked. */
  googleSubject: string | null;
  /**
   * Methods currently allowed to sign in. The plan table gained this column (see docs/cloud-plan.md): the
   * API needs it (`Account.login_methods`) and the email method cannot be derived for a Google-only account.
   */
  loginMethods: LoginMethod[];
  status: AccountStatus;
  termsVersion: string;
  termsAcceptedAt: number;
  /** Plan version counter, bumped whenever plan state changes (`X-StudentLLM-Plan-Version`). */
  planVersion: number;
  createdAt: number;
  lastSignInAt: number | null;
  /** Day granularity only (see `touchLastRequest`), so a busy account does not write on every request. */
  lastRequestAt: number | null;
}

export interface NewAccount {
  accountId: string;
  email: string;
  googleSubject: string | null;
  loginMethods: LoginMethod[];
  termsVersion: string;
  now: number;
}

/** What a paid period was bought as. A budget window exists for each period (docs/cloud-plan.md, "Quota design"). */
export type PaidPeriodKind = "subscription" | "pass";

export interface PaidPeriod {
  start: number;
  end: number;
  /** Absent on records written before the billing module (read as `subscription`). */
  kind?: PaidPeriodKind;
  /**
   * The Paddle transaction that paid for this period (a pass: the same id on all five of its periods, so a
   * replay or a second delivery cannot add them twice). Ids only; never a name or an address.
   */
  purchaseId?: string;
  /** Set when a refund or chargeback withdrew the period; the period stays as history and buys nothing. */
  revokedAt?: number;
}

/**
 * A subscription that must be canceled at Paddle although it is not the plan's current one: a duplicate bought by
 * a parallel checkout, or a replaced subscription whose own cancellation was still pending. Retried like
 * `pendingCancel`, by subscription id, always immediately. Ids only.
 */
export interface ExtraCancel {
  subscriptionId: string;
  customerId: string | null;
  reason: "duplicate" | "retired";
  requestedAt: number;
  attempts: number;
  nextAttemptAt: number;
  alerted: boolean;
}

/** A cancellation Paddle has not confirmed yet. It is visible, retried with backoff, and never silently dropped. */
export interface PendingCancel {
  when: "period_end" | "now";
  requestedAt: number;
  attempts: number;
  /** The scheduled task retries once `now >= nextAttemptAt`. */
  nextAttemptAt: number;
  /** True once the operator was alerted for this cancellation (so the alert is not repeated on every retry). */
  alerted: boolean;
}

export interface PlanRecord {
  accountId: string;
  planId: PlanId;
  status: PlanStatus;
  paidPeriods: PaidPeriod[];
  cancelAtPeriodEnd: boolean;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  /** `occurred_at` of the last applied billing event, for ordering. */
  lastEventAt: number | null;
  /** Absent or null when no cancellation is waiting for Paddle. */
  pendingCancel?: PendingCancel | null;
  /**
   * Paddle transaction ids that a refund or chargeback withdrew (the most recent ones, bounded). A period that
   * arrives later with one of these ids is recorded as already revoked, so an adjustment that is delivered
   * before its payment cannot leave a free window behind. Ids only.
   */
  revokedPurchaseIds?: string[];
  /**
   * Subscription ids this account used to have (the most recent ones, bounded). A late event of one of them
   * can add a period it paid for but never takes the plan back to a subscription that was replaced.
   */
  retiredSubscriptionIds?: string[];
  /** Every customer id this account has used besides the current one (events keep resolving through them). */
  retiredCustomerIds?: string[];
  /** Subscriptions that still have to be canceled at Paddle (see ExtraCancel). */
  extraCancels?: ExtraCancel[];
}

export interface DeletionTombstone {
  accountId: string;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  /** Every subscription id the account has seen (current, replaced, duplicate): all must be canceled before the purge. */
  paddleSubscriptionIds: string[];
  /** Every customer id the account has used. */
  paddleCustomerIds: string[];
  createdAt: number;
}

/**
 * Retry bookkeeping of a deletion, kept beside the tombstone (not in it: the tombstone holds only the Paddle ids).
 * Not account data; it goes away with the tombstone.
 */
export interface DeletionJob {
  tombstone: DeletionTombstone;
  /** How many times the subscription cancel was tried and did not finish (retry with backoff, operator alert). */
  cancelAttempts: number;
  /** Earliest time of the next cancel attempt (backoff). */
  nextAttemptAt: number;
  /** The retry period ran out: no more automatic attempts, an operator has to finish this one. */
  manualReview: boolean;
}

export type AccountPatch = Partial<Pick<AccountRecord, "status" | "lastSignInAt">>;

/** Pure and synchronous: it runs inside the store's atomic step, so it must not await or do I/O. */
export type PlanReducer = (current: PlanRecord | null) => PlanRecord;

export type SavePlanResult =
  | { ok: true; planVersion: number }
  | { ok: false; reason: "conflict"; currentPlanVersion: number }
  | { ok: false; reason: "not_found" };

export type ApplyPlanEventResult =
  /**
   * `changed` is false when the reducer produced the same plan (ignoring `lastEventAt`): the event is recorded
   * as the latest one but the plan version does not move, so a harmless duplicate does not make clients refetch.
   */
  | { applied: true; plan: PlanRecord; planVersion: number; changed: boolean }
  | { applied: false; reason: "stale" | "not_found" };

export interface AccountStore {
  /** Fails with a conflict when the email or the Google subject already belongs to an account. */
  create(input: NewAccount): Promise<{ ok: true; account: AccountRecord } | { ok: false; conflict: "email" | "google_subject" }>;
  getById(accountId: string): Promise<AccountRecord | null>;
  getByEmail(email: string): Promise<AccountRecord | null>;
  getByGoogleSubject(subject: string): Promise<AccountRecord | null>;
  update(accountId: string, patch: AccountPatch): Promise<AccountRecord | null>;
  /**
   * Records activity at day granularity: writes only when `now` is on a later UTC day than the stored
   * `lastRequestAt`. Returns whether it wrote.
   */
  touchLastRequest(accountId: string, now: number): Promise<boolean>;
  acceptTerms(accountId: string, termsVersion: string, now: number): Promise<AccountRecord | null>;
  /** Adds a method; a Google link also stores the subject. Conflicts when the subject belongs to another account. */
  addLoginMethod(
    accountId: string,
    method: LoginMethod,
    googleSubject?: string,
  ): Promise<{ ok: true; account: AccountRecord } | { ok: false; reason: "not_found" | "already_linked" | "subject_taken" }>;
  /** Never removes the last method. Unlinking Google also clears the stored subject. */
  removeLoginMethod(
    accountId: string,
    method: LoginMethod,
  ): Promise<{ ok: true; account: AccountRecord } | { ok: false; reason: "not_found" | "not_linked" | "last_method" }>;

  getPlan(accountId: string): Promise<PlanRecord | null>;
  /**
   * Compare-and-set write: succeeds only while the account's plan version is still `expectedPlanVersion`
   * (read it with the account, 0 for an account that never had a plan). Returns `conflict` otherwise, so a
   * read-modify-write cannot overwrite a concurrent change.
   */
  savePlan(plan: PlanRecord, options: { expectedPlanVersion: number }): Promise<SavePlanResult>;
  /**
   * Atomic billing-event application: reads the plan, drops the event when `occurredAt` is older than the
   * plan's `lastEventAt` (`stale`), otherwise runs `reduce`, stores the result with `lastEventAt` set to
   * `occurredAt`, and bumps the plan version when the plan changed, all in one step. Equal timestamps are applied.
   */
  applyPlanEvent(accountId: string, occurredAt: number, reduce: PlanReducer): Promise<ApplyPlanEventResult>;
  /**
   * Bumps the plan version without touching the plan or `lastEventAt` (a change that lives in the ledger, such as a
   * complimentary window, still makes clients refetch the account). Returns the new version, or null for an unknown account.
   */
  touchPlanVersion(accountId: string): Promise<number | null>;
  /** Accounts whose plan has a `pendingCancel` due at `now` (earliest first, at most `limit`). */
  listPendingCancels(now: number, limit: number): Promise<string[]>;
  /**
   * Resolves through every subscription id the account has used (current, replaced, duplicate): the index never
   * forgets an id while the account exists.
   */
  findAccountIdByPaddleSubscription(subscriptionId: string): Promise<string | null>;
  /** As above for customer ids (current and retired): a refund keeps resolving after a customer id changed. */
  findAccountIdByPaddleCustomer(customerId: string): Promise<string | null>;
  /** The account whose plan holds this Paddle transaction as the purchase of a period, or remembers it as refunded. */
  findAccountIdByPurchase(transactionId: string): Promise<string | null>;

  /**
   * Erases the account at once and keeps only a tombstone with the Paddle ids (and the retry bookkeeping): the
   * account row, the email and Google indexes, the plan and everything in it are gone when this returns, so
   * `getById` and `getByEmail` answer null and the address can sign up again. The Paddle subscription and
   * customer ids keep resolving to the account id (`findAccountIdByPaddle*`) until the tombstone is purged.
   * Idempotent: a second call returns the same tombstone. Null when there is no such account.
   */
  markDeleting(accountId: string, now: number): Promise<DeletionTombstone | null>;
  getTombstone(accountId: string): Promise<DeletionTombstone | null>;
  /**
   * Atomically claims the right to delete an account for `leaseMs`: true for exactly one of several parallel
   * callers, false for the others and for any caller while the lease runs. The claim ends with the lease, or with
   * `purgeAccount`. It makes the start of a deletion (the final email, the cancel) happen once; a caller that
   * lost the claim answers like a repeated request.
   */
  claimDeletion(accountId: string, now: number, leaseMs: number): Promise<boolean>;
  /** Stops the automatic retries of a deletion (the retry period ran out). Idempotent. */
  markDeletionManual(accountId: string): Promise<DeletionJob | null>;
  /** Deletions whose `nextAttemptAt` has passed and that are not in manual review, oldest first, at most `limit`. */
  listDueDeletions(now: number, limit: number): Promise<DeletionJob[]>;
  /** Counts a cancel attempt that did not finish and schedules the next one. Returns the job, or null. */
  recordCancelAttempt(accountId: string, nextAttemptAt: number): Promise<DeletionJob | null>;
  /** Removes the account (if any), its plan, its tombstone and the Paddle indexes. */
  purgeAccount(accountId: string): Promise<void>;
}
