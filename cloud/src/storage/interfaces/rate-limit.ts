// RateLimitStore and ConcurrencyStore. Plan row: "Sign-in counters" (connection keys) and the rate and
// concurrency limits of "Quota design". Keys are opaque strings: `acct:<accountId>` for the per-account
// window, a `SaltedHash` for a connection. Never a raw IP address or email.

import type { SaltedHash } from "../../crypto/keyed-hash";

/**
 * The key of a sliding window: `acct:<accountId>[:<purpose>]` for a per-account window, or a `SaltedHash` (rotating
 * salt, purpose-separated) for a connection or an email address. The brand makes a raw IP address or a plain
 * email a type error at the call site.
 */
export type RateLimitKey = `acct:${string}` | SaltedHash;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Hits left in the window after this call. */
  remaining: number;
  /** Seconds until the oldest counted hit leaves the window (the window fully resets later than this). */
  resetAfterSeconds: number;
  /** For a denied hit: seconds to wait before one slot frees up; null when allowed. */
  retryAfterSeconds: number | null;
}

export interface RateLimitStore {
  /**
   * Sliding-window limiter, one atomic step: counts the hits of `key` inside the last `windowMs`, allows
   * and records this hit when fewer than `limit` are counted, otherwise denies WITHOUT recording (a
   * denied client does not extend its own lockout).
   */
  hit(key: RateLimitKey, limit: number, windowMs: number, now: number): Promise<RateLimitResult>;
  deleteExpired(now: number): Promise<number>;
  /** Removes every per-account window: the key `acct:<accountId>` and every `acct:<accountId>:<purpose>` (account deletion). */
  purgeAccount(accountId: string): Promise<void>;
}

export interface ConcurrencyLease {
  id: string;
  accountId: string;
  expiresAt: number;
}

export interface ConcurrencyStore {
  /**
   * Takes a slot when fewer than `max` live leases exist for the account. The lease has a TTL so a crashed
   * request cannot hold a slot forever. Returns null when the account is at its limit
   * (`concurrency_limit`).
   */
  acquire(accountId: string, max: number, leaseMs: number, now: number): Promise<ConcurrencyLease | null>;
  /** Heartbeat for a long stream. Returns null when the lease already expired or was released. */
  renew(lease: ConcurrencyLease, leaseMs: number, now: number): Promise<ConcurrencyLease | null>;
  /** Idempotent. Release in `ctx.deferUntilBodyDone` so a stream keeps its slot until it ends. */
  release(lease: ConcurrencyLease): Promise<boolean>;
  activeCount(accountId: string, now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}
