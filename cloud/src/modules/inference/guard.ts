import type { RequestContext } from "../../http/context";
import type { Attempt } from "./attempt";

/**
 * Makes sure a content request never leaves its idempotency record `in_flight` by accident. The hooks started the
 * record before the body was read, so anything that throws afterwards must move it:
 *
 * - before a reservation exists: the record goes to `failed_before_forward` (a same-key retry is allowed);
 * - after the reservation but before the forward: the reservation is kept and the record goes to
 *   `failed_before_forward` (the retry reuses it);
 * - after the forward: the outcome is unknown, so the reservation is settled at the full amount (a crash or a bug
 *   must never be free usage).
 */
export class IdempotencyGuard {
  attempt: Attempt | undefined;

  constructor(private readonly ctx: RequestContext) {}

  async fail(): Promise<void> {
    const { deps } = this.ctx;
    try {
      if (this.attempt) {
        if (!this.attempt.open) return;
        if (this.attempt.forwarded) await this.attempt.settle(this.attempt.reservedCredits);
        else await this.attempt.failBeforeForward();
        return;
      }
      const idem = this.ctx.locals.idem;
      if (idem) await deps.stores.idempotency.transition(idem.key, ["in_flight"], "failed_before_forward", deps.clock.now());
    } catch {
      // Named only. The lease or the sweep resolves whatever this could not.
      console.error("idempotency cleanup failed");
    }
  }
}
