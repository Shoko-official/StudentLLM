// Tunable values of the inference module. Like the routing table they are configuration, and every number here
// that costs money or limits users is a PLACEHOLDER to set before launch (docs/cloud-plan.md, "Quota design" and
// "Abuse, fraud and spend limits").

export interface RateLimitSetting {
  limit: number;
  windowMs: number;
}

export interface InferenceSettings {
  /** The short sliding window per account. Content routes (chat, transcription, OCR) cost more than reads. */
  rate: { content: RateLimitSetting; read: RateLimitSetting };
  /** Concurrent content requests per account. */
  maxConcurrent: number;
  /** Reservation (and lease) time to live beyond the route's maximum duration. */
  reservationMarginMs: number;
  /** A stream extends its reservation and its concurrency lease at most this often while it makes progress. */
  heartbeatMs: number;
  /** Credits in one budget window (cost-normalized: one credit is 0.0001 EUR at the routing-table price). */
  windowCredits: number;
  /**
   * The global spend cap, in cost-normalized credits across all accounts. A new request gets `kill_switch` once the
   * SETTLED total has reached the cap or its own reservation would pass it. It is not an exact ceiling: requests
   * already in flight have reserved but not settled, so the spend can overshoot by up to the reservations in flight
   * (requests in flight x the largest reservation, about 27 credits for the default model). Size the cap with that
   * margin; an exact ceiling would need to reserve against the cap in the same step as the account's reservation.
   */
  spendCap: { dayCredits: number; monthCredits: number };
  /** Largest upstream JSON body the gateway reads for a non-streaming call. */
  maxUpstreamBodyBytes: number;
  /** Largest single SSE event or line the gateway buffers from an upstream stream. */
  maxSseEventBytes: number;
  retryAfter: {
    /** `idempotency_conflict` while the first attempt is in flight. */
    inProgressSeconds: number;
    /** `concurrency_limit`. */
    concurrencySeconds: number;
    /** `provider_unavailable`. */
    providerSeconds: number;
    /** `kill_switch`. */
    killSwitchSeconds: number;
  };
}

/** PLACEHOLDERS, verify before launch. */
export const DEFAULT_SETTINGS: InferenceSettings = {
  rate: {
    content: { limit: 20, windowMs: 60_000 },
    read: { limit: 120, windowMs: 60_000 },
  },
  maxConcurrent: 2,
  reservationMarginMs: 60_000,
  heartbeatMs: 30_000,
  // 15000 credits = 1.50 EUR: the worst-case cost ceiling per Plus user per month in docs/cloud-plan.md.
  windowCredits: 15_000,
  // 500000 credits = 50 EUR per day, 5000000 credits = 500 EUR per month.
  spendCap: { dayCredits: 500_000, monthCredits: 5_000_000 },
  maxUpstreamBodyBytes: 4 * 1024 * 1024,
  maxSseEventBytes: 1024 * 1024,
  retryAfter: { inProgressSeconds: 5, concurrencySeconds: 2, providerSeconds: 10, killSwitchSeconds: 60 },
};

export function mergeSettings(overrides: DeepPartial<InferenceSettings> | undefined): InferenceSettings {
  const o = overrides ?? {};
  const merged: InferenceSettings = {
    ...DEFAULT_SETTINGS,
    ...(o as Partial<InferenceSettings>),
    rate: {
      content: { ...DEFAULT_SETTINGS.rate.content, ...o.rate?.content },
      read: { ...DEFAULT_SETTINGS.rate.read, ...o.rate?.read },
    },
    spendCap: { ...DEFAULT_SETTINGS.spendCap, ...o.spendCap },
    retryAfter: { ...DEFAULT_SETTINGS.retryAfter, ...o.retryAfter },
  };
  const positive = (n: number, what: string): void => {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`inference settings: ${what} must be a positive integer`);
  };
  positive(merged.rate.content.limit, "content rate limit");
  positive(merged.rate.content.windowMs, "content rate window");
  positive(merged.rate.read.limit, "read rate limit");
  positive(merged.rate.read.windowMs, "read rate window");
  positive(merged.maxConcurrent, "maxConcurrent");
  positive(merged.reservationMarginMs, "reservationMarginMs");
  positive(merged.heartbeatMs, "heartbeatMs");
  positive(merged.windowCredits, "windowCredits");
  positive(merged.spendCap.dayCredits, "day spend cap");
  positive(merged.spendCap.monthCredits, "month spend cap");
  return merged;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
