// Durable Object class exports, reserved now so the entry module's export list (and therefore the
// wrangler migrations) is settled before the module owners start. Nothing is bound in wrangler.toml yet.
//
// TODO(owner: ops/inference): `AccountObject` is the per-account object of docs/cloud-plan.md. It will hold
// - DeviceStore.register (the 3-device limit check and insert, ONE atomic step),
// - the ledger, reservations, idempotency records and the sweep schedule (alarm -> ledger.sweep(accountId)),
// - rate-limit windows, concurrency leases and revocations.
// Adding a class later means a new wrangler migration; renaming one is a data migration. Keep the name.

import type { Env } from "./config";
import { errorResponse } from "./http/envelope";
import type { DurableObjectState } from "./platform";

export class AccountObject {
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return errorResponse("internal_error", "req_durable_object", { message: "This object is not implemented yet." });
  }

  /** The reconciler alarm: will call `ledger.sweep(accountId, now)` for this object's account. */
  async alarm(): Promise<void> {}
}
