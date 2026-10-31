// Provider sets: the named, versioned lists of providers a user consents to (docs/cloud-plan.md, "Provider
// strategy"). The routing table of the inference module is the source: this module reads the sets through
// `providerSetCatalog(deps)`, which is `providerSetViews(deps.inference.routing)` unless a test (or another
// deployment) overrides `AccountDeps.providerSets`. So `GET /v1/provider-sets`, `GET /v1/models` and the consent
// check (which compares a record with the routing table too) can only agree.

import type { Deps } from "../../deps";
import type { Feature } from "../../storage";
import { providerSetViews } from "../inference/catalog";

export interface ProviderSetInfo {
  id: string;
  version: number;
  providers: readonly string[];
  regions: readonly string[];
  consentTextVersion: string;
  features: readonly Feature[];
}

export interface ProviderSetCatalog {
  list(): readonly ProviderSetInfo[];
}

/** The catalog the account handlers use: the override of `AccountDeps.providerSets`, else the inference routing table. */
export function providerSetCatalog(deps: Deps): ProviderSetCatalog {
  return deps.account.providerSets ?? { list: () => providerSetViews(deps.inference.routing) };
}
