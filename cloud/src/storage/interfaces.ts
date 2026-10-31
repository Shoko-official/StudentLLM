// Storage interfaces of the gateway. They mirror the data table in docs/cloud-plan.md ("The complete
// list of what the service stores") and nothing else: no content, no IP address, no prompt, no answer,
// no body hash or fingerprint, no plaintext token or code.
//
// Conventions
// - Every method that depends on time takes `now` (epoch milliseconds) so tests are deterministic.
// - Every method that the plan calls "atomic" is one call here. An adapter must make it a single step.
// - Records returned to callers are copies; mutating them never changes the store.
//
// Adapters (TODO(owner: ops)): the in-memory implementations in ./memory are for tests and local dev
// only. The Durable Object and D1 adapters come later. Plan authority (accounts, plan, consent,
// webhook ledger) belongs to D1; live counters, reservations, revocations and the device list belong to
// the account Durable Object. The account Durable Object MUST perform `DeviceStore.register` (the limit
// check and the device insert) as one atomic step, so two parallel sign-ins cannot both take the last
// slot.

import type { ConsentFeature } from "../types";

export type LoginMethod = "google" | "email";
export type AccountStatus = "active" | "suspended" | "deleting";
export type Feature = ConsentFeature;
export type PlanId = "free" | "plus_monthly" | "plus_semester";
export type PlanStatus = "none" | "active" | "past_due" | "canceled" | "revoked";

// ---------------------------------------------------------------------------------------------
// AccountStore. Plan rows: "Account", "Plan", "Deletion tombstone".
// ---------------------------------------------------------------------------------------------

export interface AccountRecord {
  /** Random opaque id, the key for everything. */
  accountId: string;
  /** The single verified sign-in email, lower case, stored in clear because the service sends mail to it. */
  email: string;
  /** Google subject id, only while Google is linked. */
  googleSubject: string | null;
  /**
   * Methods currently allowed to sign in. The plan table has no column for this, but the API needs it
   * (`Account.login_methods`) and the email method cannot be derived for a Google-only account.
   */
  loginMethods: LoginMethod[];
  status: AccountStatus;
  termsVersion: string;
  termsAcceptedAt: number;
  /** Plan version counter, bumped whenever plan state changes (`X-StudentLLM-Plan-Version`). */
  planVersion: number;
  createdAt: number;
  lastSignInAt: number | null;
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

export type AccountPatch = Partial<Pick<AccountRecord, "status" | "lastSignInAt" | "lastRequestAt">>;

export interface AccountStore {
  /** Fails with a conflict when the email or the Google subject already belongs to an account. */
  create(input: NewAccount): Promise<{ ok: true; account: AccountRecord } | { ok: false; conflict: "email" | "google_subject" }>;
  getById(accountId: string): Promise<AccountRecord | null>;
  getByEmail(email: string): Promise<AccountRecord | null>;
  getByGoogleSubject(subject: string): Promise<AccountRecord | null>;
  update(accountId: string, patch: AccountPatch): Promise<AccountRecord | null>;
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
  /** Saves the plan and bumps the account's plan version in the same step. Returns the new version. */
  savePlan(plan: PlanRecord): Promise<number | null>;
  findAccountIdByPaddleSubscription(subscriptionId: string): Promise<string | null>;
  findAccountIdByPaddleCustomer(customerId: string): Promise<string | null>;

  /** Sets status `deleting` and keeps only the Paddle ids in a tombstone. Idempotent. */
  markDeleting(accountId: string, now: number): Promise<DeletionTombstone | null>;
  getTombstone(accountId: string): Promise<DeletionTombstone | null>;
  /** Removes the account, its plan and its tombstone. */
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// SessionStore. Plan row: "Sessions" (the device id and label half lives in DeviceStore).
// ---------------------------------------------------------------------------------------------

export interface SessionRecord {
  /** Refresh family id (the access token's `sid`). */
  familyId: string;
  accountId: string;
  deviceId: string;
  /** Hash of the current refresh token. */
  currentHash: string;
  /** Hash and rotation time of the previous token, for reuse detection and the retry grace window. */
  prevHash: string | null;
  rotatedAt: number | null;
  /** The successor token encrypted under a key derived from the previous token; erased after the grace window. */
  graceSuccessor: string | null;
  /** Time of the last fresh sign-in; a refresh copies it unchanged. */
  authTime: number;
  createdAt: number;
  lastUsedAt: number;
  /** 30 days idle. */
  idleExpiresAt: number;
  /** 180 days absolute. */
  absoluteExpiresAt: number;
  revokedAt: number | null;
}

export interface SessionStore {
  create(session: SessionRecord): Promise<void>;
  getByFamily(familyId: string): Promise<SessionRecord | null>;
  /** Finds the family that owns this refresh token hash, as its current or its previous token. */
  findByTokenHash(hash: string): Promise<{ session: SessionRecord; match: "current" | "previous" } | null>;
  /**
   * Compare-and-set rotation: only succeeds while `expectedCurrentHash` is still current and the family is
   * not revoked. The old current hash becomes `prevHash`.
   */
  rotate(
    familyId: string,
    expectedCurrentHash: string,
    next: { newHash: string; graceSuccessor: string | null; now: number; idleExpiresAt: number },
  ): Promise<SessionRecord | null>;
  /** Erases the encrypted successor (grace window over, or the successor was used). */
  clearGrace(familyId: string): Promise<void>;
  revokeFamily(familyId: string, now: number): Promise<boolean>;
  revokeByDevice(accountId: string, deviceId: string, now: number): Promise<number>;
  revokeAllForAccount(accountId: string, now: number): Promise<number>;
  /** Sessions that are neither revoked nor expired. */
  listActiveByAccount(accountId: string, now: number): Promise<SessionRecord[]>;
  /** Deletes expired and revoked sessions ("until expiry or revocation, then deleted"). */
  deleteExpired(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// DeviceStore. Plan rows: "Device counters", "Manage token", and the device half of "Sessions".
// ---------------------------------------------------------------------------------------------

export const MAX_DEVICES = 3;
export const MAX_MANAGE_TOKENS_PER_CODE = 3;

export interface DeviceRecord {
  deviceId: string;
  accountId: string;
  /** Platform name, editable. */
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface ManageTokenRecord {
  /** SHA-256 of the opaque `mt_` token. The token itself is never stored or logged. */
  tokenHash: string;
  accountId: string;
  expiresAt: number;
  /** Id of the sign-in code that produced it (not the code). */
  codeId: string;
  uses: number;
}

export interface DeviceStore {
  /**
   * The limit check and the device insert as ONE atomic step. A device id that already belongs to the
   * account is refreshed without using a slot; one that belongs to another account is refused.
   */
  register(input: {
    accountId: string;
    deviceId: string;
    label: string;
    now: number;
    limit?: number;
  }): Promise<
    | { ok: true; device: DeviceRecord; created: boolean }
    | { ok: false; reason: "device_limit_reached" | "device_id_taken" }
  >;
  get(accountId: string, deviceId: string): Promise<DeviceRecord | null>;
  list(accountId: string): Promise<DeviceRecord[]>;
  touch(accountId: string, deviceId: string, now: number): Promise<void>;
  /** Revocation applies to the very next request: `isActive` turns false at once. */
  revoke(accountId: string, deviceId: string): Promise<boolean>;
  isActive(accountId: string, deviceId: string): Promise<boolean>;

  /** New-session count per account and day (`dayKey` like `2026-11-01`), for anomaly detection. */
  incrementNewSessions(accountId: string, dayKey: string): Promise<number>;
  getNewSessions(accountId: string, dayKey: string): Promise<number>;
  /** Daily counts are kept 30 days. */
  pruneNewSessions(beforeDayKey: string): Promise<number>;

  /** Stores a manage token unless `MAX_MANAGE_TOKENS_PER_CODE` were already minted for the code. */
  mintManageToken(record: Omit<ManageTokenRecord, "uses">, now: number): Promise<boolean>;
  getManageToken(tokenHash: string, now: number): Promise<ManageTokenRecord | null>;
  recordManageTokenUse(tokenHash: string): Promise<void>;
  deleteExpiredManageTokens(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// ConsentStore (append-only). Plan row: "Consent".
// ---------------------------------------------------------------------------------------------

export interface ConsentRow {
  consentId: string;
  accountId: string;
  providerSetId: string;
  providerSetVersion: number;
  features: Feature[];
  textVersion: string;
  granted: boolean;
  recordedAt: number;
}

export type NewConsent = Omit<ConsentRow, "recordedAt">;

export interface ConsentStore {
  /**
   * Appends a record, except that an identical request to the latest record of the provider set returns
   * that record (idempotent by construction). There is no update and no delete besides `purgeAccount`.
   */
  record(input: NewConsent, now: number): Promise<{ row: ConsentRow; created: boolean }>;
  /** The latest record of the set when it is a grant: at most one active record per provider set. */
  getActive(accountId: string, providerSetId: string): Promise<ConsentRow | null>;
  /** Looks a record up by id; works for withdrawn and replaced records too. */
  getById(accountId: string, consentId: string): Promise<ConsentRow | null>;
  /** Active records, one per provider set at most. */
  listActive(accountId: string): Promise<ConsentRow[]>;
  /** The full history, for the account export. */
  listAll(accountId: string): Promise<ConsentRow[]>;
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// LedgerStore: credit windows, reservations, settlement. Plan row: "Usage" (and the windows of "Plan").
// ---------------------------------------------------------------------------------------------

export interface BudgetWindow {
  accountId: string;
  /** Windows are keyed by their start. */
  start: number;
  end: number;
  limit: number;
  used: number;
  reserved: number;
  byFeature: Record<Feature, number>;
  requests: number;
  revokedAt: number | null;
}

export type ReservationState = "reserved" | "settled" | "released";

export interface Reservation {
  requestId: string;
  accountId: string;
  windowStart: number;
  feature: Feature;
  credits: number;
  state: ReservationState;
  /** True once the request was sent upstream; an expired forwarded reservation settles at the full amount. */
  forwarded: boolean;
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

export interface LedgerStore {
  /** Creates the window when missing. Never resets `used` or `reserved` of an existing one. */
  ensureWindow(input: { accountId: string; start: number; end: number; limit: number }): Promise<BudgetWindow>;
  getCurrentWindow(accountId: string, now: number): Promise<BudgetWindow | null>;
  listWindows(accountId: string): Promise<BudgetWindow[]>;
  /** Refund or chargeback: revokes the current and all future windows (those ending after `now`). */
  revokeWindows(accountId: string, now: number): Promise<number>;

  /** Atomic: checks the remaining budget of the current window and reserves `credits` (a positive integer). */
  reserve(input: { requestId: string; accountId: string; feature: Feature; credits: number; now: number; expiresAt: number }): Promise<ReserveResult>;
  getReservation(requestId: string): Promise<Reservation | null>;
  markForwarded(requestId: string): Promise<boolean>;
  /** Heartbeat for a stream that is making progress. */
  extendReservation(requestId: string, expiresAt: number): Promise<boolean>;
  /**
   * The first settlement wins; later ones are ignored and counted. The charge is capped at the
   * reservation, because `max_tokens` is clamped before the reservation is made.
   */
  settle(input: { requestId: string; credits: number; logicalModelId: string; now: number }): Promise<SettleResult>;
  /** Releases a reservation that was never forwarded or failed with no usage (zero credits charged). */
  release(requestId: string): Promise<boolean>;
  /** For the reconciler: reservations still `reserved` whose expiry has passed. */
  findExpiredReservations(now: number): Promise<Reservation[]>;
  getLedgerEntry(requestId: string): Promise<LedgerEntry | null>;
  /** Double-settlement attempts that were ignored (a counter, never content). */
  doubleSettlementCount(accountId: string): Promise<number>;
  /** Deletes ledger rows settled before `beforeMs` (rows live 24 hours; window totals keep the sums). */
  pruneLedger(beforeMs: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// IdempotencyStore. Plan row: "Idempotency record".
// ---------------------------------------------------------------------------------------------

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyState = "in_flight" | "failed_before_forward" | "failed_no_usage" | "settled";

export interface IdempotencyRecord {
  accountId: string;
  route: string;
  /** SHA-256 of the client's key. Nothing derived from the body is ever stored. */
  keyHash: string;
  /** The attempt that owns the reservation. */
  requestId: string;
  state: IdempotencyState;
  creditsCharged: number | null;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyKey {
  accountId: string;
  route: string;
  keyHash: string;
}

export type IdempotencyBegin =
  | { outcome: "started"; record: IdempotencyRecord }
  /** Same key after `failed_before_forward` (keeps the original request id, so the reservation is reused) or `failed_no_usage`. */
  | { outcome: "retry"; record: IdempotencyRecord; previousState: "failed_before_forward" | "failed_no_usage" }
  /** `in_progress` or `settled`: the route answers `idempotency_conflict` and takes no concurrency slot. */
  | { outcome: "conflict"; state: "in_progress" | "settled"; record: IdempotencyRecord };

export interface IdempotencyStore {
  begin(key: IdempotencyKey, requestId: string, now: number): Promise<IdempotencyBegin>;
  /** Atomic compare-and-set of the state. Returns null when the record is missing or not in a `from` state. */
  transition(
    key: IdempotencyKey,
    from: IdempotencyState[],
    to: IdempotencyState,
    now: number,
    extras?: { creditsCharged?: number },
  ): Promise<IdempotencyRecord | null>;
  get(key: IdempotencyKey, now: number): Promise<IdempotencyRecord | null>;
  /** `failed_no_usage` events per account and hour (anomaly signal). `hourKey` is `floor(ms / 3600000)`. */
  failedNoUsageCount(accountId: string, hourKey: number): Promise<number>;
  deleteExpired(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// AuthChallengeStore. Plan rows: "Pending sign-in", "Link ticket", "Sign-in counters".
// ---------------------------------------------------------------------------------------------

export interface PendingSignIn {
  id: string;
  kind: "google" | "email";
  /** Google: hash of the OAuth state. */
  stateHash: string | null;
  /** Email: keyed hash of the normalized address, the lookup key (the plan stores no clear email here). */
  emailHash: string | null;
  codeChallenge: string;
  redirectType: "loopback" | "deep_link" | null;
  termsVersion: string;
  linkTicketId: string | null;
  /** Keyed HMAC of the one-time email code, or of the single-use authorization code issued after the Google callback. */
  codeHash: string | null;
  /** Set when the Google callback resolved an account; needed to mint tokens at /auth/token. */
  accountId: string | null;
  attempts: number;
  resends: number;
  createdAt: number;
  expiresAt: number;
}

export interface LinkTicket {
  /** Hash of the ticket. */
  ticketHash: string;
  accountId: string;
  method: LoginMethod;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface AuthChallengeStore {
  put(pending: PendingSignIn): Promise<void>;
  /** Stores the pending email sign-in and invalidates every earlier one for the same address. */
  replaceForEmail(pending: PendingSignIn): Promise<void>;
  getByStateHash(stateHash: string, now: number): Promise<PendingSignIn | null>;
  getByEmailHash(emailHash: string, now: number): Promise<PendingSignIn | null>;
  getByCodeHash(codeHash: string, now: number): Promise<PendingSignIn | null>;
  /** Counts a wrong attempt and returns the new count, or null when the record is gone. */
  incrementAttempts(id: string): Promise<number | null>;
  delete(id: string): Promise<void>;
  /** Atomic get-and-delete of a live record: single use. */
  consume(id: string, now: number): Promise<PendingSignIn | null>;

  putLinkTicket(ticket: LinkTicket): Promise<void>;
  /** Atomic single use: returns the ticket once, and null afterwards or when expired. */
  consumeLinkTicket(ticketHash: string, now: number): Promise<LinkTicket | null>;

  /** Request and failed-attempt counters keyed by a salted hash (see crypto/keyed-hash). Entries expire. */
  incrementCounter(key: string, now: number, ttlMs: number): Promise<number>;
  getCounter(key: string, now: number): Promise<number>;
  deleteExpired(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// WebhookEventStore. Plan row: "Webhook ledger".
// ---------------------------------------------------------------------------------------------

export type WebhookEventState = "processing" | "processed" | "quarantined";
export type WebhookFields = Readonly<Record<string, string | number | boolean | null>>;

export interface WebhookEventRecord {
  eventId: string;
  eventType: string;
  occurredAt: number;
  state: WebhookEventState;
  /** Allowlisted scalar fields only (ids, status, period, price id). Everything else is discarded. */
  fields: WebhookFields;
  claimedAt: number;
  updatedAt: number;
}

export type WebhookClaim =
  | { outcome: "claimed"; record: WebhookEventRecord }
  /** A claim left in `processing` for too long was taken over. */
  | { outcome: "taken_over"; record: WebhookEventRecord }
  /** Already processed or quarantined: answer 2xx without effects. */
  | { outcome: "duplicate"; record: WebhookEventRecord }
  /** Another worker is processing it right now. */
  | { outcome: "in_progress"; record: WebhookEventRecord };

export interface WebhookEventStore {
  /** Atomic claim of an event id (a unique-key insert in D1). */
  claim(input: { eventId: string; eventType: string; occurredAt: number }, now: number, staleAfterMs: number): Promise<WebhookClaim>;
  complete(eventId: string, state: "processed" | "quarantined", fields: WebhookFields, now: number): Promise<WebhookEventRecord | null>;
  /** A failed processing releases the claim so Paddle's retry works. */
  release(eventId: string): Promise<boolean>;
  get(eventId: string): Promise<WebhookEventRecord | null>;
  listQuarantined(): Promise<WebhookEventRecord[]>;
  deleteOlderThan(beforeMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------------------------

export interface Stores {
  accounts: AccountStore;
  sessions: SessionStore;
  devices: DeviceStore;
  consents: ConsentStore;
  ledger: LedgerStore;
  idempotency: IdempotencyStore;
  authChallenges: AuthChallengeStore;
  webhookEvents: WebhookEventStore;
}
