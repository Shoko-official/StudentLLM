import type {
  BudgetWindow,
  Feature,
  IdempotencyRef,
  IdempotencyStore,
  LedgerEntry,
  LedgerStore,
  Reservation,
  ReserveResult,
  SettleResult,
  SweepRegistry,
  SweepResult,
  WindowFilter,
  WindowSource,
} from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

function assertCredits(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/**
 * In-memory ledger. It owns a reference to the idempotency store and the sweep registry because, in the
 * real adapter, all three live in the same account Durable Object and change in one step. Every method body
 * is synchronous apart from the awaited store calls that the in-memory stores resolve immediately, and
 * state is read and written before any suspension point that another call could observe.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly windows = new Map<string, BudgetWindow>(); // key: accountId|start
  private readonly reservations = new Map<string, Reservation>(); // key: accountId|requestId
  private readonly entries = new Map<string, LedgerEntry>(); // key: accountId|requestId
  private readonly doubleSettlements = new Map<string, number>();

  constructor(
    private readonly idempotency: IdempotencyStore,
    private readonly sweeps: SweepRegistry,
  ) {}

  private wKey(accountId: string, start: number): string {
    return `${accountId}|${start}`;
  }

  private rKey(accountId: string, requestId: string): string {
    return `${accountId}|${requestId}`;
  }

  private window(r: Reservation): BudgetWindow {
    return this.windows.get(this.wKey(r.accountId, r.windowStart))!;
  }

  private current(accountId: string, now: number): BudgetWindow | undefined {
    for (const w of this.windows.values()) {
      if (w.accountId === accountId && w.revokedAt === null && w.start <= now && now < w.end) return w;
    }
    return undefined;
  }

  private matches(w: BudgetWindow, filter: WindowFilter | undefined): boolean {
    if (!filter) return true;
    if (filter.source !== undefined && w.source !== filter.source) return false;
    if (filter.grantId !== undefined && w.grantId !== filter.grantId) return false;
    return true;
  }

  async ensureWindow(
    accountId: string,
    input: { start: number; end: number; limit: number; source?: WindowSource; grantId?: string },
  ) {
    assertCredits(input.limit, "limit");
    if (input.end <= input.start) throw new RangeError("window end must be after its start");
    const key = this.wKey(accountId, input.start);
    let w = this.windows.get(key);
    if (!w) {
      w = {
        accountId,
        start: input.start,
        source: input.source ?? "paddle",
        grantId: input.grantId ?? null,
        end: input.end,
        limit: input.limit,
        used: 0,
        reserved: 0,
        byFeature: { chat: 0, transcription: 0, ocr: 0 },
        requests: 0,
        revokedAt: null,
      };
      this.windows.set(key, w);
    }
    return copy(w);
  }

  async getCurrentWindow(accountId: string, now: number) {
    const w = this.current(accountId, now);
    return w ? copy(w) : null;
  }

  async listWindows(accountId: string) {
    return [...this.windows.values()]
      .filter((w) => w.accountId === accountId)
      .sort((a, b) => a.start - b.start)
      .map(copy);
  }

  async revokeWindows(accountId: string, now: number, filter?: WindowFilter) {
    let n = 0;
    for (const w of this.windows.values()) {
      if (w.accountId === accountId && w.revokedAt === null && w.end > now && this.matches(w, filter)) {
        w.revokedAt = now;
        n++;
      }
    }
    return n;
  }

  async truncateWindows(accountId: string, at: number, filter?: WindowFilter) {
    let n = 0;
    for (const w of this.windows.values()) {
      if (w.accountId !== accountId || w.revokedAt !== null || w.end <= at || !this.matches(w, filter)) continue;
      if (w.start >= at) w.revokedAt = at;
      else w.end = at;
      n++;
    }
    return n;
  }

  async reserve(
    accountId: string,
    input: { requestId: string; feature: Feature; credits: number; now: number; expiresAt: number; idempotency: IdempotencyRef | null },
  ): Promise<ReserveResult> {
    assertCredits(input.credits, "credits");
    if (input.credits < 1) throw new RangeError("a reservation needs at least one credit");
    if (this.reservations.has(this.rKey(accountId, input.requestId))) return { ok: false, reason: "duplicate_request" };
    const w = this.current(accountId, input.now);
    if (!w) return { ok: false, reason: "no_window" };
    const remaining = w.limit - w.used - w.reserved;
    if (remaining < input.credits) return { ok: false, reason: "budget_exhausted", remaining, resetsAt: w.end };
    w.reserved += input.credits;
    const reservation: Reservation = {
      requestId: input.requestId,
      accountId,
      windowStart: w.start,
      feature: input.feature,
      credits: input.credits,
      state: "reserved",
      forwarded: false,
      idempotency: input.idempotency ? { ...input.idempotency } : null,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    };
    this.reservations.set(this.rKey(accountId, reservation.requestId), reservation);
    await this.sweeps.schedule(accountId, input.expiresAt);
    return { ok: true, reservation: copy(reservation), remaining: remaining - input.credits, resetsAt: w.end };
  }

  async getReservation(accountId: string, requestId: string) {
    const r = this.reservations.get(this.rKey(accountId, requestId));
    return r ? copy(r) : null;
  }

  async markForwarded(accountId: string, requestId: string) {
    const r = this.reservations.get(this.rKey(accountId, requestId));
    if (!r || r.state !== "reserved") return false;
    r.forwarded = true;
    return true;
  }

  async extendReservation(accountId: string, requestId: string, expiresAt: number) {
    const r = this.reservations.get(this.rKey(accountId, requestId));
    if (!r || r.state !== "reserved") return false;
    r.expiresAt = Math.max(r.expiresAt, expiresAt);
    await this.sweeps.schedule(accountId, r.expiresAt);
    return true;
  }

  /** Marks the reservation settled and updates the window. Synchronous, so it cannot interleave. */
  private settleNow(r: Reservation, credits: number, logicalModelId: string, now: number): { charged: number; entry: LedgerEntry } {
    const w = this.window(r);
    const charged = Math.min(credits, r.credits);
    w.reserved -= r.credits;
    w.used += charged;
    w.byFeature[r.feature] += charged;
    w.requests += 1;
    r.state = "settled";
    const entry: LedgerEntry = {
      requestId: r.requestId,
      accountId: r.accountId,
      feature: r.feature,
      logicalModelId,
      credits: charged,
      settledAt: now,
    };
    this.entries.set(this.rKey(r.accountId, r.requestId), entry);
    return { charged, entry };
  }

  private releaseNow(r: Reservation): void {
    this.window(r).reserved -= r.credits;
    r.state = "released";
  }

  private idemKey(r: Reservation) {
    return r.idempotency ? { accountId: r.accountId, route: r.idempotency.route, keyHash: r.idempotency.keyHash } : null;
  }

  async settle(
    accountId: string,
    input: { requestId: string; credits: number; logicalModelId: string; now: number },
  ): Promise<SettleResult> {
    assertCredits(input.credits, "credits");
    const r = this.reservations.get(this.rKey(accountId, input.requestId));
    if (!r) return { settled: false, reason: "unknown" };
    if (r.state === "settled") {
      this.doubleSettlements.set(accountId, (this.doubleSettlements.get(accountId) ?? 0) + 1);
      return { settled: false, reason: "duplicate" };
    }
    if (r.state === "released") return { settled: false, reason: "released" };
    const { charged, entry } = this.settleNow(r, input.credits, input.logicalModelId, input.now);
    const key = this.idemKey(r);
    if (key) await this.idempotency.transition(key, ["in_flight"], "settled", input.now, { creditsCharged: charged });
    return { settled: true, charged, entry: copy(entry) };
  }

  async release(accountId: string, requestId: string, now: number) {
    const r = this.reservations.get(this.rKey(accountId, requestId));
    if (!r || r.state !== "reserved") return false;
    this.releaseNow(r);
    const key = this.idemKey(r);
    if (key) await this.idempotency.transition(key, ["in_flight"], "failed_no_usage", now, { creditsCharged: 0 });
    return true;
  }

  async markFailedBeforeForward(accountId: string, requestId: string, now: number) {
    const r = this.reservations.get(this.rKey(accountId, requestId));
    if (!r || r.state !== "reserved" || r.forwarded) return false;
    const key = this.idemKey(r);
    if (key) await this.idempotency.transition(key, ["in_flight"], "failed_before_forward", now);
    return true;
  }

  async sweep(accountId: string, now: number): Promise<SweepResult> {
    let settled = 0;
    let released = 0;
    for (const r of [...this.reservations.values()]) {
      if (r.accountId !== accountId || r.state !== "reserved" || r.expiresAt > now) continue;
      const key = this.idemKey(r);
      if (r.forwarded) {
        // Unknown outcome: a crash cannot create free usage, so charge the full reservation.
        const { charged } = this.settleNow(r, r.credits, "unknown_outcome", now);
        if (key) await this.idempotency.transition(key, ["in_flight"], "settled", now, { creditsCharged: charged });
        settled++;
      } else {
        this.releaseNow(r);
        if (key) await this.idempotency.transition(key, ["in_flight"], "failed_no_usage", now, { creditsCharged: 0, countAnomaly: false });
        released++;
      }
    }
    let nextDueAt: number | null = null;
    for (const r of this.reservations.values()) {
      if (r.accountId === accountId && r.state === "reserved" && (nextDueAt === null || r.expiresAt < nextDueAt)) nextDueAt = r.expiresAt;
    }
    await this.sweeps.reschedule(accountId, nextDueAt);
    return { settled, released, nextDueAt };
  }

  async getLedgerEntry(accountId: string, requestId: string) {
    const e = this.entries.get(this.rKey(accountId, requestId));
    return e ? copy(e) : null;
  }

  async doubleSettlementCount(accountId: string) {
    return this.doubleSettlements.get(accountId) ?? 0;
  }

  async pruneLedger(accountId: string, beforeMs: number) {
    let n = 0;
    for (const [k, e] of [...this.entries]) {
      if (e.accountId === accountId && e.settledAt < beforeMs) {
        this.entries.delete(k);
        n++;
      }
    }
    // Settled and released reservations carry no more information than the window totals.
    for (const [k, r] of [...this.reservations]) {
      if (r.accountId === accountId && r.state !== "reserved" && r.createdAt < beforeMs) this.reservations.delete(k);
    }
    return n;
  }

  async purgeAccount(accountId: string) {
    for (const [k, w] of [...this.windows]) if (w.accountId === accountId) this.windows.delete(k);
    for (const [k, r] of [...this.reservations]) if (r.accountId === accountId) this.reservations.delete(k);
    for (const [k, e] of [...this.entries]) if (e.accountId === accountId) this.entries.delete(k);
    this.doubleSettlements.delete(accountId);
    await this.sweeps.clear(accountId);
  }
}
