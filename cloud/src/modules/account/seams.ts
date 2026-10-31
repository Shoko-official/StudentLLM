// How the account module reaches the other modules' seams (src/modules/seams.ts). The billing and inference
// modules implement their seams on their own deps objects; until they do, these accessors fall back to safe
// defaults, so the account module works (and is tested) on its own and picks the real ones up as they land.
//
// The fallbacks are deliberately inert: no subscription is cancelled (`none`), usage is zero, and the ledger
// purge is a no-op. Account deletion does not depend on the last one: it also purges the ledger store directly.

import type { Deps } from "../../deps";
import type { BillingSeam, InferenceSeam } from "../seams";

export const defaultBillingSeam: BillingSeam = {
  async cancelSubscription() {
    return { state: "none" };
  },
};

export const defaultInferenceSeam: InferenceSeam = {
  async usageSnapshot() {
    return { creditsUsed: 0, windowStart: null, windowEnd: null };
  },
  async purgeLedger() {},
};

export function billingSeam(deps: Deps): BillingSeam {
  const candidate = deps.billing as Partial<BillingSeam>;
  return typeof candidate.cancelSubscription === "function" ? (candidate as BillingSeam) : defaultBillingSeam;
}

export function inferenceSeam(deps: Deps): InferenceSeam {
  const candidate = deps.inference as Partial<InferenceSeam>;
  return typeof candidate.usageSnapshot === "function" && typeof candidate.purgeLedger === "function"
    ? (candidate as InferenceSeam)
    : defaultInferenceSeam;
}
