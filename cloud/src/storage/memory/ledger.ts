import type {
  BudgetWindow,
  Feature,
  LedgerEntry,
  LedgerStore,
  Reservation,
  ReserveResult,
  SettleResult,
} from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

function assertCredits(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly windows = new Map<string, BudgetWindow>(); // key: accountId|start
  private readonly reservations = new Map<string, Reservation>();
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly doubleSettlements = new Map<string, number>();

  private windowKey(accountId: string, start: number): string {
    return `${accountId}|${start}`;
  }

  async ensureWindow(input: { accountId: string; start: number; end: number; limit: number }) {
    assertCredits(input.limit, "limit");
    if (input.end <= input.start) throw new RangeError("window end must be after its start");
    const key = this.windowKey(input.accountId, input.start);
    let w = this.windows.get(key);
    if (!w) {
      w = {
        accountId: input.accountId,
        start: input.start,
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

  private current(accountId: string, now: number): BudgetWindow | undefined {
    for (const w of this.windows.values()) {
      if (w.accountId === accountId && w.revokedAt === null && w.start <= now && now < w.end) return w;
    }
    return undefined;
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

  async revokeWindows(accountId: string, now: number) {
    let n = 0;
    for (const w of this.windows.values()) {
      if (w.accountId === accountId && w.revokedAt === null && w.end > now) {
        w.revokedAt = now;
        n++;
      }
    }
    return n;
  }

  async reserve(input: {
    requestId: string;
    accountId: string;
    feature: Feature;
    credits: number;
    now: number;
    expiresAt: number;
  }): Promise<ReserveResult> {
    assertCredits(input.credits, "credits");
    if (input.credits < 1) throw new RangeError("a reservation needs at least one credit");
    if (this.reservations.has(input.requestId)) return { ok: false, reason: "duplicate_request" };
    const w = this.current(input.accountId, input.now);
    if (!w) return { ok: false, reason: "no_window" };
    const remaining = w.limit - w.used - w.reserved;
    if (remaining < input.credits) return { ok: false, reason: "budget_exhausted", remaining, resetsAt: w.end };
    w.reserved += input.credits;
    const reservation: Reservation = {
      requestId: input.requestId,
      accountId: input.accountId,
      windowStart: w.start,
      feature: input.feature,
      credits: input.credits,
      state: "reserved",
      forwarded: false,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    };
    this.reservations.set(reservation.requestId, reservation);
    return { ok: true, reservation: copy(reservation), remaining: remaining - input.credits, resetsAt: w.end };
  }

  async getReservation(requestId: string) {
    const r = this.reservations.get(requestId);
    return r ? copy(r) : null;
  }

  async markForwarded(requestId: string) {
    const r = this.reservations.get(requestId);
    if (!r || r.state !== "reserved") return false;
    r.forwarded = true;
    return true;
  }

  async extendReservation(requestId: string, expiresAt: number) {
    const r = this.reservations.get(requestId);
    if (!r || r.state !== "reserved") return false;
    r.expiresAt = Math.max(r.expiresAt, expiresAt);
    return true;
  }

  async settle(input: { requestId: string; credits: number; logicalModelId: string; now: number }): Promise<SettleResult> {
    assertCredits(input.credits, "credits");
    const r = this.reservations.get(input.requestId);
    if (!r) return { settled: false, reason: "unknown" };
    if (r.state === "settled") {
      this.doubleSettlements.set(r.accountId, (this.doubleSettlements.get(r.accountId) ?? 0) + 1);
      return { settled: false, reason: "duplicate" };
    }
    if (r.state === "released") return { settled: false, reason: "released" };
    const w = this.windows.get(this.windowKey(r.accountId, r.windowStart))!;
    const charged = Math.min(input.credits, r.credits);
    w.reserved -= r.credits;
    w.used += charged;
    w.byFeature[r.feature] += charged;
    w.requests += 1;
    r.state = "settled";
    const entry: LedgerEntry = {
      requestId: r.requestId,
      accountId: r.accountId,
      feature: r.feature,
      logicalModelId: input.logicalModelId,
      credits: charged,
      settledAt: input.now,
    };
    this.entries.set(entry.requestId, entry);
    return { settled: true, charged, entry: copy(entry) };
  }

  async release(requestId: string) {
    const r = this.reservations.get(requestId);
    if (!r || r.state !== "reserved") return false;
    const w = this.windows.get(this.windowKey(r.accountId, r.windowStart))!;
    w.reserved -= r.credits;
    r.state = "released";
    return true;
  }

  async findExpiredReservations(now: number) {
    return [...this.reservations.values()].filter((r) => r.state === "reserved" && r.expiresAt <= now).map(copy);
  }

  async getLedgerEntry(requestId: string) {
    const e = this.entries.get(requestId);
    return e ? copy(e) : null;
  }

  async doubleSettlementCount(accountId: string) {
    return this.doubleSettlements.get(accountId) ?? 0;
  }

  async pruneLedger(beforeMs: number) {
    let n = 0;
    for (const [id, e] of [...this.entries]) {
      if (e.settledAt < beforeMs) {
        this.entries.delete(id);
        n++;
      }
    }
    // Settled and released reservations carry no more information than the window totals.
    for (const [id, r] of [...this.reservations]) {
      if (r.state !== "reserved" && r.createdAt < beforeMs) this.reservations.delete(id);
    }
    return n;
  }

  async purgeAccount(accountId: string) {
    for (const [k, w] of [...this.windows]) if (w.accountId === accountId) this.windows.delete(k);
    for (const [k, r] of [...this.reservations]) if (r.accountId === accountId) this.reservations.delete(k);
    for (const [k, e] of [...this.entries]) if (e.accountId === accountId) this.entries.delete(k);
    this.doubleSettlements.delete(accountId);
  }
}
