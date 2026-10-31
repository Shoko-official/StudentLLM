// Cross-module calls. Each module implements its own seam; callers use them through Deps.
export interface AuthSeam {
  revokeAllSessions(accountId: string): Promise<void>;
  revokeManageTokens(accountId: string): Promise<void>;
}
export interface BillingSeam {
  cancelSubscription(accountId: string, when: "period_end" | "now"): Promise<{ state: "cancelled" | "pending" | "none" }>;
}
export interface InferenceSeam {
  usageSnapshot(accountId: string): Promise<{ creditsUsed: number; windowStart: string | null; windowEnd: string | null }>;
  purgeLedger(accountId: string): Promise<void>;
}
