import type { CoreDeps } from "../../deps";
import { placeholderProviderSets, type ProviderSetCatalog } from "./provider-sets";

export interface AccountDeps {
  providerSets: ProviderSetCatalog;
  /** Called when an account deletion keeps failing to cancel the subscription (the operator alert). Name-only: no account data. */
  /** How long the final deletion email may take before the deletion goes on without it (a hanging provider must not block it). */
  deletionEmailTimeoutMs: number;
  alertOperator: (event: "deletion_cancel_failing" | "deletion_needs_manual_review") => void;
}

export function createAccountDeps(_core: CoreDeps, overrides: Partial<AccountDeps> = {}): AccountDeps {
  return {
    providerSets: placeholderProviderSets,
    deletionEmailTimeoutMs: 5_000,
    alertOperator: (event) => console.error(`operator alert: ${event}`),
    ...overrides,
  };
}
