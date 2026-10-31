import type { RateLimitKey, RateLimitResult, RateLimitStore } from "../interfaces";

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, { windowMs: number; times: number[] }>();

  async hit(key: RateLimitKey, limit: number, windowMs: number, now: number): Promise<RateLimitResult> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("window must be a positive integer");
    const entry = this.hits.get(key) ?? { windowMs, times: [] };
    entry.windowMs = windowMs;
    entry.times = entry.times.filter((t) => t > now - windowMs);
    const resetAt = (): number => (entry.times[0] === undefined ? 0 : Math.max(0, Math.ceil((entry.times[0] + windowMs - now) / 1000)));
    if (entry.times.length >= limit) {
      this.hits.set(key, entry);
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAfterSeconds: resetAt(),
        retryAfterSeconds: Math.max(1, resetAt()),
      };
    }
    entry.times.push(now);
    this.hits.set(key, entry);
    return { allowed: true, limit, remaining: limit - entry.times.length, resetAfterSeconds: resetAt(), retryAfterSeconds: null };
  }

  async hitAccount(accountId: string, bucket: string, limit: number, windowMs: number, now: number) {
    return this.hit(`acct:${accountId}:${bucket}`, limit, windowMs, now);
  }

  async purgeAccount(accountId: string) {
    for (const key of [...this.hits.keys()]) {
      if (key === `acct:${accountId}` || key.startsWith(`acct:${accountId}:`)) this.hits.delete(key);
    }
  }

  async deleteExpired(now: number) {
    let n = 0;
    for (const [key, e] of [...this.hits]) {
      if (e.times.every((t) => t <= now - e.windowMs)) {
        this.hits.delete(key);
        n++;
      }
    }
    return n;
  }
}
