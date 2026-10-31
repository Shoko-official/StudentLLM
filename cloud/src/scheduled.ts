import type { ScheduledController } from "./platform";

/**
 * Work for the Worker's `scheduled` (cron) handler. Each module returns its tasks from
 * `create<Module>ScheduledTasks(deps)`; the app runs them all and a failing task never stops the others.
 *
 * Inference tasks (src/modules/inference/sweeper.ts): `inference-sweep`, the reservation sweep safety net
 * (`deps.stores.sweeps.due(now, limit)` then `ledger.sweep(accountId, now)` for each account, ledger rows pruned on
 * the way), and `inference-expire`, which removes expired idempotency records and rate-limit windows.
 * Still planned (TODO(owner: auth)): pruning of expired sign-in challenges; (TODO(owner: ops)): the daily rollup of
 * spend counters.
 */
export interface ScheduledTask {
  /** Stable name, used in the failure log (never log task data). */
  readonly name: string;
  run(controller: ScheduledController): Promise<void>;
}
