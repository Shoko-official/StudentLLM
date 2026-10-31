import type {
  AccountPatch,
  AccountRecord,
  AccountStore,
  ApplyPlanEventResult,
  DeletionJob,
  DeletionTombstone,
  TombstoneCancel,
  LoginMethod,
  NewAccount,
  PlanReducer,
  PlanRecord,
  SavePlanResult,
} from "../interfaces";

const DAY_MS = 24 * 60 * 60 * 1000;

const copy = <T>(value: T): T => structuredClone(value);

/** The earliest time a cancellation of this plan (the plan's own or an extra one) is due, or null when none waits. */
function dueAt(plan: PlanRecord): number | null {
  const times = [plan.pendingCancel?.nextAttemptAt, ...(plan.extraCancels ?? []).map((e) => e.nextAttemptAt)].filter((t): t is number => typeof t === "number");
  return times.length === 0 ? null : Math.min(...times);
}

/** Key-sorted JSON; undefined values and a null `pendingCancel` are dropped so "absent" and "null" compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (v === undefined || (key === "pendingCancel" && v === null)) return undefined;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

/** In-memory AccountStore for tests and local dev. Every method body is synchronous, hence atomic. */
export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly byEmail = new Map<string, string>();
  private readonly byGoogle = new Map<string, string>();
  private readonly plans = new Map<string, PlanRecord>();
  private readonly bySubscription = new Map<string, string>();
  private readonly byCustomer = new Map<string, string>();
  private readonly byPurchase = new Map<string, string>();
  private readonly tombstones = new Map<string, DeletionTombstone>();
  private readonly deletionClaims = new Map<string, number>();
  private readonly retries = new Map<string, { cancelAttempts: number; nextAttemptAt: number; manualReview: boolean }>();

  async create(input: NewAccount) {
    const email = input.email.toLowerCase();
    if (this.byEmail.has(email)) return { ok: false as const, conflict: "email" as const };
    if (input.googleSubject !== null && this.byGoogle.has(input.googleSubject)) {
      return { ok: false as const, conflict: "google_subject" as const };
    }
    const account: AccountRecord = {
      accountId: input.accountId,
      email,
      googleSubject: input.googleSubject,
      loginMethods: [...input.loginMethods],
      status: "active",
      termsVersion: input.termsVersion,
      termsAcceptedAt: input.now,
      planVersion: 0,
      createdAt: input.now,
      lastSignInAt: null,
      lastRequestAt: null,
    };
    this.accounts.set(account.accountId, account);
    this.byEmail.set(email, account.accountId);
    if (account.googleSubject !== null) this.byGoogle.set(account.googleSubject, account.accountId);
    return { ok: true as const, account: copy(account) };
  }

  async getById(accountId: string) {
    const a = this.accounts.get(accountId);
    return a ? copy(a) : null;
  }

  async getByEmail(email: string) {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.getById(id) : null;
  }

  async getByGoogleSubject(subject: string) {
    const id = this.byGoogle.get(subject);
    return id ? this.getById(id) : null;
  }

  async update(accountId: string, patch: AccountPatch) {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    Object.assign(a, patch);
    return copy(a);
  }

  async touchLastRequest(accountId: string, now: number) {
    const a = this.accounts.get(accountId);
    if (!a) return false;
    if (a.lastRequestAt !== null && Math.floor(a.lastRequestAt / DAY_MS) >= Math.floor(now / DAY_MS)) return false;
    a.lastRequestAt = now;
    return true;
  }

  async acceptTerms(accountId: string, termsVersion: string, now: number) {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    a.termsVersion = termsVersion;
    a.termsAcceptedAt = now;
    return copy(a);
  }

  async addLoginMethod(accountId: string, method: LoginMethod, googleSubject?: string) {
    const a = this.accounts.get(accountId);
    if (!a) return { ok: false as const, reason: "not_found" as const };
    if (a.loginMethods.includes(method)) return { ok: false as const, reason: "already_linked" as const };
    if (method === "google") {
      if (googleSubject === undefined) throw new TypeError("linking Google needs the subject id");
      const owner = this.byGoogle.get(googleSubject);
      if (owner !== undefined && owner !== accountId) return { ok: false as const, reason: "subject_taken" as const };
      a.googleSubject = googleSubject;
      this.byGoogle.set(googleSubject, accountId);
    }
    a.loginMethods.push(method);
    return { ok: true as const, account: copy(a) };
  }

  async removeLoginMethod(accountId: string, method: LoginMethod) {
    const a = this.accounts.get(accountId);
    if (!a) return { ok: false as const, reason: "not_found" as const };
    if (!a.loginMethods.includes(method)) return { ok: false as const, reason: "not_linked" as const };
    if (a.loginMethods.length === 1) return { ok: false as const, reason: "last_method" as const };
    a.loginMethods = a.loginMethods.filter((m) => m !== method);
    if (method === "google" && a.googleSubject !== null) {
      this.byGoogle.delete(a.googleSubject);
      a.googleSubject = null;
    }
    return { ok: true as const, account: copy(a) };
  }

  async getPlan(accountId: string) {
    const p = this.plans.get(accountId);
    return p ? copy(p) : null;
  }

  private store(a: AccountRecord, plan: PlanRecord): number {
    this.plans.set(plan.accountId, copy(plan));
    // The indexes only grow while the account exists: an id the account used stays resolvable after the plan
    // moved on (a refund names a customer or a payment from an earlier purchase). The first owner of an id keeps it.
    const claim = (index: Map<string, string>, id: string | null | undefined): void => {
      if (id && !index.has(id)) index.set(id, plan.accountId);
    };
    claim(this.bySubscription, plan.paddleSubscriptionId);
    for (const id of plan.retiredSubscriptionIds ?? []) claim(this.bySubscription, id);
    for (const e of plan.extraCancels ?? []) claim(this.bySubscription, e.subscriptionId);
    claim(this.byCustomer, plan.paddleCustomerId);
    for (const id of plan.retiredCustomerIds ?? []) claim(this.byCustomer, id);
    for (const period of plan.paidPeriods) claim(this.byPurchase, period.purchaseId);
    for (const id of plan.revokedPurchaseIds ?? []) claim(this.byPurchase, id);
    a.planVersion += 1;
    return a.planVersion;
  }

  async savePlan(plan: PlanRecord, options: { expectedPlanVersion: number }): Promise<SavePlanResult> {
    const a = this.accounts.get(plan.accountId);
    if (!a) return { ok: false, reason: "not_found" };
    if (a.planVersion !== options.expectedPlanVersion) {
      return { ok: false, reason: "conflict", currentPlanVersion: a.planVersion };
    }
    return { ok: true, planVersion: this.store(a, plan) };
  }

  async applyPlanEvent(accountId: string, occurredAt: number, reduce: PlanReducer): Promise<ApplyPlanEventResult> {
    const a = this.accounts.get(accountId);
    if (!a) return { applied: false, reason: "not_found" };
    const current = this.plans.get(accountId) ?? null;
    if (current?.lastEventAt != null && occurredAt < current.lastEventAt) return { applied: false, reason: "stale" };
    const next = copy(reduce(current ? copy(current) : null));
    if (next.accountId !== accountId) throw new Error("a plan reducer must keep the account id");
    next.lastEventAt = occurredAt;
    // An identical plan (a duplicate delivery, a metadata-only event) is recorded as the latest event but does
    // not move the plan version: clients refetch the account only when the version changes.
    const changed = current === null || canonical({ ...current, lastEventAt: null }) !== canonical({ ...next, lastEventAt: null });
    if (!changed) {
      this.plans.set(accountId, copy(next));
      return { applied: true, plan: copy(next), planVersion: a.planVersion, changed: false };
    }
    const planVersion = this.store(a, next);
    return { applied: true, plan: copy(next), planVersion, changed: true };
  }

  async touchPlanVersion(accountId: string) {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    a.planVersion += 1;
    return a.planVersion;
  }

  async listPendingCancels(now: number, limit: number) {
    const due = new Map<string, number>();
    for (const p of this.plans.values()) {
      const at = dueAt(p);
      if (at !== null) due.set(p.accountId, at);
    }
    for (const t of this.tombstones.values()) {
      if (t.cancel?.state === "pending") due.set(t.accountId, Math.min(due.get(t.accountId) ?? Infinity, t.cancel.nextAttemptAt));
    }
    return [...due]
      .filter(([, at]) => at <= now)
      .sort((x, y) => x[1] - y[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  async addTombstoneSubscription(accountId: string, subscriptionId: string, customerId: string | null) {
    const t = this.tombstones.get(accountId);
    if (!t) return null;
    const subs = new Set([...(t.paddleSubscriptionIds ?? []), ...(t.paddleSubscriptionId ? [t.paddleSubscriptionId] : []), subscriptionId]);
    t.paddleSubscriptionIds = [...subs];
    if (customerId !== null) {
      const customers = new Set([...(t.paddleCustomerIds ?? []), ...(t.paddleCustomerId ? [t.paddleCustomerId] : []), customerId]);
      t.paddleCustomerIds = [...customers];
      if (!this.byCustomer.has(customerId)) this.byCustomer.set(customerId, accountId);
    }
    if (!this.bySubscription.has(subscriptionId)) this.bySubscription.set(subscriptionId, accountId);
    return copy(t);
  }

  async setTombstoneCancel(accountId: string, cancel: TombstoneCancel | null) {
    const t = this.tombstones.get(accountId);
    if (!t) return null;
    t.cancel = cancel === null ? null : copy(cancel);
    return copy(t);
  }

  async findAccountIdByPaddleSubscription(subscriptionId: string) {
    return this.bySubscription.get(subscriptionId) ?? null;
  }

  async findAccountIdByPaddleCustomer(customerId: string) {
    return this.byCustomer.get(customerId) ?? null;
  }

  async findAccountIdByPurchase(transactionId: string) {
    return this.byPurchase.get(transactionId) ?? null;
  }

  async markDeleting(accountId: string, now: number) {
    const existing = this.tombstones.get(accountId);
    if (existing) return copy(existing);
    const a = this.accounts.get(accountId);
    if (!a) return null;
    const plan = this.plans.get(accountId);
    const subscriptionIds = new Set<string>();
    for (const id of [plan?.paddleSubscriptionId, ...(plan?.retiredSubscriptionIds ?? []), ...(plan?.extraCancels ?? []).map((e) => e.subscriptionId)]) if (id) subscriptionIds.add(id);
    const customerIds = new Set<string>();
    for (const id of [plan?.paddleCustomerId, ...(plan?.retiredCustomerIds ?? [])]) if (id) customerIds.add(id);
    const tombstone: DeletionTombstone = {
      accountId,
      paddleCustomerId: plan?.paddleCustomerId ?? null,
      paddleSubscriptionId: plan?.paddleSubscriptionId ?? null,
      createdAt: now,
    };
    // Billing: every other subscription and customer id the account used, so the deletion can cancel all of them.
    if (subscriptionIds.size > (plan?.paddleSubscriptionId ? 1 : 0)) tombstone.paddleSubscriptionIds = [...subscriptionIds];
    if (customerIds.size > (plan?.paddleCustomerId ? 1 : 0)) tombstone.paddleCustomerIds = [...customerIds];
    this.tombstones.set(accountId, tombstone);
    this.retries.set(accountId, { cancelAttempts: 0, nextAttemptAt: now, manualReview: false });
    // Erase: the account row, its plan and the email and Google indexes. The Paddle indexes stay with the tombstone.
    this.byEmail.delete(a.email);
    if (a.googleSubject !== null) this.byGoogle.delete(a.googleSubject);
    this.accounts.delete(accountId);
    this.plans.delete(accountId);
    return copy(tombstone);
  }

  async getTombstone(accountId: string) {
    const t = this.tombstones.get(accountId);
    return t ? copy(t) : null;
  }

  private job(accountId: string): DeletionJob | null {
    const tombstone = this.tombstones.get(accountId);
    const retry = this.retries.get(accountId);
    return tombstone && retry ? copy({ tombstone, ...retry }) : null;
  }

  async listDueDeletions(now: number, limit: number) {
    return [...this.tombstones.keys()]
      .map((id) => this.job(id)!)
      .filter((j) => !j.manualReview && j.nextAttemptAt <= now)
      .sort((a, b) => a.tombstone.createdAt - b.tombstone.createdAt)
      .slice(0, limit);
  }

  async recordCancelAttempt(accountId: string, nextAttemptAt: number) {
    const retry = this.retries.get(accountId);
    if (!retry) return null;
    retry.cancelAttempts += 1;
    retry.nextAttemptAt = nextAttemptAt;
    return this.job(accountId);
  }

  async claimDeletion(accountId: string, now: number, leaseMs: number) {
    if (!this.accounts.has(accountId) && !this.tombstones.has(accountId)) return false;
    if ((this.deletionClaims.get(accountId) ?? 0) > now) return false;
    this.deletionClaims.set(accountId, now + leaseMs);
    return true;
  }

  async markDeletionManual(accountId: string) {
    const retry = this.retries.get(accountId);
    if (!retry) return null;
    retry.manualReview = true;
    return this.job(accountId);
  }

  async purgeAccount(accountId: string) {
    const t = this.tombstones.get(accountId);
    if (t?.paddleSubscriptionId) this.bySubscription.delete(t.paddleSubscriptionId);
    if (t?.paddleCustomerId) this.byCustomer.delete(t.paddleCustomerId);
    const a = this.accounts.get(accountId);
    if (a) {
      this.byEmail.delete(a.email);
      if (a.googleSubject !== null) this.byGoogle.delete(a.googleSubject);
    }
    for (const index of [this.bySubscription, this.byCustomer, this.byPurchase]) {
      for (const [id, owner] of [...index]) if (owner === accountId) index.delete(id);
    }
    this.accounts.delete(accountId);
    this.plans.delete(accountId);
    this.tombstones.delete(accountId);
    this.retries.delete(accountId);
    this.deletionClaims.delete(accountId);
  }
}
