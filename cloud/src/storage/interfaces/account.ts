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

export interface PaidPeriod {
  start: number;
  end: number;
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
}

export interface DeletionTombstone {
  accountId: string;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  createdAt: number;
}

export type AccountPatch = Partial<Pick<AccountRecord, "status" | "lastSignInAt">>;

/** Pure and synchronous: it runs inside the store's atomic step, so it must not await or do I/O. */
export type PlanReducer = (current: PlanRecord | null) => PlanRecord;

export type SavePlanResult =
  | { ok: true; planVersion: number }
  | { ok: false; reason: "conflict"; currentPlanVersion: number }
  | { ok: false; reason: "not_found" };

export type ApplyPlanEventResult =
  | { applied: true; plan: PlanRecord; planVersion: number }
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
   * `occurredAt`, and bumps the plan version, all in one step. Equal timestamps are applied.
   */
  applyPlanEvent(accountId: string, occurredAt: number, reduce: PlanReducer): Promise<ApplyPlanEventResult>;
  findAccountIdByPaddleSubscription(subscriptionId: string): Promise<string | null>;
  findAccountIdByPaddleCustomer(customerId: string): Promise<string | null>;

  /** Sets status `deleting` and keeps only the Paddle ids in a tombstone. Idempotent. */
  markDeleting(accountId: string, now: number): Promise<DeletionTombstone | null>;
  getTombstone(accountId: string): Promise<DeletionTombstone | null>;
  /** Removes the account, its plan and its tombstone. */
  purgeAccount(accountId: string): Promise<void>;
}
