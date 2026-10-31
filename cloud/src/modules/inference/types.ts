import type { ConcurrencyLease, ConsentRow, IdempotencyKey, IdempotencyRef } from "../../storage";
import type { InferenceSeam } from "../seams";
import type { ProviderRegistry } from "./provider";
import type { RoutingTable } from "./routing";
import type { InferenceSettings } from "./settings";

/**
 * What other modules and the handlers reach through `deps.inference`. It implements `InferenceSeam` (the usage
 * snapshot and the ledger purge for account deletion), so a caller writes `deps.inference.purgeLedger(accountId)`.
 */
export interface InferenceDeps extends InferenceSeam {
  /** The validated routing table: models, providers, provider sets, prices and limits. */
  readonly routing: RoutingTable;
  readonly settings: InferenceSettings;
  /** Resolves the upstream provider of a routing-table endpoint. */
  readonly providers: ProviderRegistry;
  /** The per-account HMAC pseudonym sent upstream as `user`; the account id and the email never are. */
  pseudonym(accountId: string): Promise<string>;
}

/** State the content hooks hand to the handlers (see `RequestLocals`). */
export interface IdempotencyLocal {
  key: IdempotencyKey;
  ref: IdempotencyRef;
  /** The request id that owns the reservation: this request's, or the original one after `failed_before_forward`. */
  ownerRequestId: string;
  /** True when a same-key retry may reuse the reservation the first attempt left behind. */
  reuseReservation: boolean;
  /** The lease given to the record, so a re-begin uses the same one. */
  leaseMs: number;
}

declare module "../../http/context" {
  interface RequestLocals {
    /** Set by `lookupIdempotency` on the content routes. */
    idem?: IdempotencyLocal;
    /** Set by `acquireConcurrencySlot`. */
    lease?: ConcurrencyLease;
    /** The active consent record `checkConsent` verified. */
    consent?: ConsentRow;
  }
}
