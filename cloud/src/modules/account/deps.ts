import type { CoreDeps } from "../../deps";
import { placeholderProviderSets, type ProviderSetCatalog } from "./provider-sets";

export interface AccountDeps {
  providerSets: ProviderSetCatalog;
  /** Called when an account deletion keeps failing to cancel the subscription (the operator alert). Name-only: no account data. */
  alertOperator: (event: "deletion_cancel_failing") => void;
}

export function createAccountDeps(_core: CoreDeps, overrides: Partial<AccountDeps> = {}): AccountDeps {
  return {
    providerSets: placeholderProviderSets,
    alertOperator: (event) => console.error(`operator alert: ${event}`),
    ...overrides,
  };
}
