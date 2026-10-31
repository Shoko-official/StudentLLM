// Cross-module calls. Each module implements its own seam; callers use them through Deps.
export interface AuthSeam {
  revokeAllSessions(accountId: string): Promise<void>;
  revokeManageTokens(accountId: string): Promise<void>;
}
export interface BillingSeam {
  /**
   * Cancels the subscription of an account. When the account is being deleted (the only caller today) its plan row
   * is ALREADY ERASED: `accounts.getPlan(accountId)` answers null and `accounts.getById` answers null. The
   * implementation must resolve the Paddle subscription and customer ids with `accounts.getTombstone(accountId)`
   * and cancel every id it holds; reading the plan would find no subscription, report `none`, and let the
   * tombstone be purged while the subscription keeps billing. Must be idempotent (it is retried).
   */
  cancelSubscription(accountId: string, when: "period_end" | "now"): Promise<{ state: "cancelled" | "pending" | "none" }>;
}
export interface InferenceSeam {
  usageSnapshot(accountId: string): Promise<{ creditsUsed: number; windowStart: string | null; windowEnd: string | null }>;
  purgeLedger(accountId: string): Promise<void>;
}
