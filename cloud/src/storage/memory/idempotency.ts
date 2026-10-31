import {
  IDEMPOTENCY_TTL_MS,
  type IdempotencyBegin,
  type IdempotencyKey,
  type IdempotencyRecord,
  type IdempotencyState,
  type IdempotencyStore,
} from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);
const mapKey = (k: IdempotencyKey) => `${k.accountId}|${k.route}|${k.keyHash}`;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly failedNoUsage = new Map<string, number>(); // accountId|hourKey

  private live(key: IdempotencyKey, now: number): IdempotencyRecord | undefined {
    const r = this.records.get(mapKey(key));
    if (r && r.expiresAt <= now) {
      this.records.delete(mapKey(key));
      return undefined;
    }
    return r;
  }

  async begin(key: IdempotencyKey, requestId: string, now: number): Promise<IdempotencyBegin> {
    const existing = this.live(key, now);
    if (!existing) {
      const record: IdempotencyRecord = {
        ...key,
        requestId,
        state: "in_flight",
        creditsCharged: null,
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      };
      this.records.set(mapKey(key), record);
      return { outcome: "started", record: copy(record) };
    }
    switch (existing.state) {
      case "in_flight":
        return { outcome: "conflict", state: "in_progress", record: copy(existing) };
      case "settled":
        return { outcome: "conflict", state: "settled", record: copy(existing) };
      case "failed_before_forward":
      case "failed_no_usage": {
        const previousState = existing.state;
        // failed_before_forward keeps the original request id: its reservation is reused.
        // failed_no_usage released its reservation, so the new attempt owns a new one.
        if (previousState === "failed_no_usage") existing.requestId = requestId;
        existing.state = "in_flight";
        return { outcome: "retry", record: copy(existing), previousState };
      }
    }
  }

  async transition(
    key: IdempotencyKey,
    from: IdempotencyState[],
    to: IdempotencyState,
    now: number,
    extras: { creditsCharged?: number } = {},
  ) {
    const r = this.live(key, now);
    if (!r || !from.includes(r.state)) return null;
    r.state = to;
    if (extras.creditsCharged !== undefined) r.creditsCharged = extras.creditsCharged;
    if (to === "failed_no_usage") {
      const hourKey = `${key.accountId}|${Math.floor(now / 3_600_000)}`;
      this.failedNoUsage.set(hourKey, (this.failedNoUsage.get(hourKey) ?? 0) + 1);
    }
    return copy(r);
  }

  async get(key: IdempotencyKey, now: number) {
    const r = this.live(key, now);
    return r ? copy(r) : null;
  }

  async failedNoUsageCount(accountId: string, hourKey: number) {
    return this.failedNoUsage.get(`${accountId}|${hourKey}`) ?? 0;
  }

  async deleteExpired(now: number) {
    let n = 0;
    for (const [k, r] of [...this.records]) {
      if (r.expiresAt <= now) {
        this.records.delete(k);
        n++;
      }
    }
    return n;
  }

  async purgeAccount(accountId: string) {
    for (const [k, r] of [...this.records]) if (r.accountId === accountId) this.records.delete(k);
    for (const k of [...this.failedNoUsage.keys()]) if (k.startsWith(`${accountId}|`)) this.failedNoUsage.delete(k);
  }
}
