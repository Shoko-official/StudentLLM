// IdempotencyStore. Plan row: "Idempotency record".

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

export interface IdempotencyTransitionExtras {
  creditsCharged?: number;
  /**
   * Count a move to `failed_no_usage` in the per-account hourly anomaly signal. Default true. The
   * reconciler passes false when it releases an expired reservation that was never forwarded.
   */
  countAnomaly?: boolean;
}

/**
 * Normally the ledger drives these transitions (`LedgerStore.settle`, `release`, `markFailedBeforeForward`
 * and `sweep` move the record in the same call as the reservation). `begin` and `get` are for the route.
 */
export interface IdempotencyStore {
  begin(key: IdempotencyKey, requestId: string, now: number): Promise<IdempotencyBegin>;
  /** Atomic compare-and-set of the state. Returns null when the record is missing or not in a `from` state. */
  transition(
    key: IdempotencyKey,
    from: IdempotencyState[],
    to: IdempotencyState,
    now: number,
    extras?: IdempotencyTransitionExtras,
  ): Promise<IdempotencyRecord | null>;
  get(key: IdempotencyKey, now: number): Promise<IdempotencyRecord | null>;
  /** `failed_no_usage` events per account and hour (anomaly signal). `hourKey` is `floor(ms / 3600000)`. */
  failedNoUsageCount(accountId: string, hourKey: number): Promise<number>;
  deleteExpired(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}
