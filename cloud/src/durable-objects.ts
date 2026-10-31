// Durable Object class exports, reserved now so the entry module's export list (and therefore the
// wrangler migrations) is settled before the module owners start. Nothing is bound in wrangler.toml yet.
//
// `AccountObject` is the per-account object of docs/cloud-plan.md. ONE object per account holds, and runs as single
// atomic steps, everything that must not interleave for that account:
//
//   ledger        reserve (budget check + reservation + idempotency `markReserved` + sweep schedule), settle (the
//                 first wins, and the idempotency record moves in the same step), release, markFailedBeforeForward,
//                 markForwarded, extendReservation, sweep, pruneLedger, ensureWindow, revokeWindows
//   idempotency   begin (including the lease takeover of a crashed attempt), transition, get, failedNoUsageCount
//   rateLimits    hitAccount (the per-account buckets `content` and `read`)
//   concurrency   acquire, renew, release (leases with a time to live)
//   devices       register (the 3-device limit check and the insert, ONE step), revocations
//
// Every one of these methods takes the account (or a key / lease that carries it) as its first argument, so the
// adapter routes the call to `env.ACCOUNT_OBJECT.idFromName(accountId)` without parsing anything. A test
// (`durable-objects.test.ts`) drives a full set of requests through proxies and asserts that no call of these stores
// ever names more than one account, which is what lets each call map onto one object.
//
// What stays OUTSIDE the object: the sweep registry (`stores.sweeps`, which accounts are due, read by the cron
// safety net), the switches and global spend counters (`stores.switches`, one small global object), connection-keyed
// rate-limit windows (`stores.rateLimits.hit`, the auth module), and plan authority (D1).
//
// The object's alarm is the primary reconciler: `ledger.reserve` and `extendReservation` arm it at the earliest
// reservation expiry, and `alarm()` calls `ledger.sweep(accountId, now)` and re-arms it with `nextDueAt`. The cron
// `scheduled` handler (`inference-sweep`) is only the safety net.
//
// Adding a class later means a new wrangler migration; renaming one is a data migration. Keep the name.
// TODO(owner: ops): the adapters (Durable Object storage and D1) are not written yet; the in-memory stores in
// src/storage/memory implement the same interfaces and the same behavior suites (`runStoreContract`,
// `runInferenceStoreContract`) will run against the adapters.

import type { Env } from "./config";
import { errorResponse } from "./http/envelope";
import type { DurableObjectState } from "./platform";
import type { Stores } from "./storage";

/** The stores whose every call is scoped to one account: the part of `Stores` that lives inside `AccountObject`. */
export type AccountObjectStores = Pick<Stores, "ledger" | "idempotency" | "rateLimits" | "concurrency">;

export class AccountObject {
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return errorResponse("internal_error", "req_durable_object", { message: "This object is not implemented yet." });
  }

  /** The reconciler alarm: will call `ledger.sweep(accountId, now)` for this object's account and re-arm itself. */
  async alarm(): Promise<void> {}
}
