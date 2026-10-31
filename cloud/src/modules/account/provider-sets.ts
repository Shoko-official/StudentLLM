// Provider sets: the named, versioned lists of providers a user consents to (docs/cloud-plan.md, "Provider
// strategy"). The routing table (inference module) will be the real source; until it exists the account module
// reads this catalog through `AccountDeps.providerSets`, so consent can be recorded and tested now.

import type { Feature } from "../../storage";

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

/**
 * Placeholder catalog. The provider name, the region and the consent text version are not decided yet (provider
 * checklist, consent text); nothing here is a real value.
 * TODO(owner: inference): replace with the provider sets of the routing table.
 */
export const placeholderProviderSets: ProviderSetCatalog = {
  list: () => [
    {
      id: "ps1",
      version: 1,
      providers: ["[PLACEHOLDER: provider]"],
      regions: ["[PLACEHOLDER: region]"],
      consentTextVersion: "2026-11-01",
      features: ["chat"],
    },
  ],
};
