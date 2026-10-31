import type { ScheduledController } from "./platform";

/**
 * Work for the Worker's `scheduled` (cron) handler. Each module returns its tasks from
 * `create<Module>ScheduledTasks(deps)`; the app runs them all and a failing task never stops the others.
 *
 * Planned tasks (TODO(owner: inference)): the reservation sweep safety net
 * (`deps.stores.sweeps.due(now, limit)` then `ledger.sweep(accountId, now)` for each account), pruning of
 * expired idempotency records, challenges and ledger rows, and the daily rollup of spend counters.
 */
export interface ScheduledTask {
  /** Stable name, used in the failure log (never log task data). */
  readonly name: string;
  run(controller: ScheduledController): Promise<void>;
}
