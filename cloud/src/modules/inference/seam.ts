// The inference module's side of the cross-module seam (src/modules/seams.ts): what account export, account
// deletion and the billing module may ask of the ledger.

import type { CoreDeps } from "../../deps";
import type { InferenceSeam } from "../seams";
import { formatTime } from "./attempt";

export function createInferenceSeam(core: CoreDeps): InferenceSeam {
  return {
    /** Credits used in the window that is current now (zero and no dates when there is none). */
    async usageSnapshot(accountId) {
      const window = await core.stores.ledger.getCurrentWindow(accountId, core.clock.now());
      if (!window) return { creditsUsed: 0, windowStart: null, windowEnd: null };
      return { creditsUsed: window.used, windowStart: formatTime(window.start), windowEnd: formatTime(window.end) };
    },

    /**
     * Account deletion: removes every record of this account that the inference module owns (windows, reservations,
     * the settled ledger, idempotency records, rate-limit buckets, concurrency leases and the sweep schedule).
     * Idempotent. The global spend counters hold no account data and stay.
     */
    async purgeLedger(accountId) {
      const { ledger, idempotency, rateLimits, concurrency } = core.stores;
      await Promise.all([ledger.purgeAccount(accountId), idempotency.purgeAccount(accountId), rateLimits.purgeAccount(accountId), concurrency.purgeAccount(accountId)]);
    },
  };
}
