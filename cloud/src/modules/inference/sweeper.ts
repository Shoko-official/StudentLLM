// The reconciler (docs/cloud-plan.md, "Reserve then settle"): expired reservations are resolved per account, on
// access and by the cron safety net. A reservation that never reached the provider is released; one that was
// forwarded with an unknown outcome (a crash, a missing usage chunk, a client abort) is settled at the full
// reservation, so a crash cannot create free usage. Nothing scans all accounts: the cron asks the sweep
// registry which accounts are due.

import type { Deps } from "../../deps";
import type { ScheduledTask } from "../../scheduled";
import type { SweepResult } from "../../storage";
import { addSpend } from "./availability";

/** Ledger rows live 24 hours; window totals keep the sums. */
const LEDGER_ROW_TTL_MS = 24 * 60 * 60 * 1000;
/** Accounts handled per cron run; the rest are due again at the next run. */
const SWEEPS_PER_RUN = 200;

/** Sweeps one account now: the on-access sweep and the unit of work of the cron task. */
export async function sweepAccount(deps: Deps, accountId: string): Promise<SweepResult> {
  const now = deps.clock.now();
  const result = await deps.stores.ledger.sweep(accountId, now);
  // Credits settled for unknown outcomes are real spend; count them in the global spend cap.
  await addSpend(deps, result.settledCredits, now);
  await deps.stores.ledger.pruneLedger(accountId, now - LEDGER_ROW_TTL_MS);
  return result;
}

export function createSweepTasks(deps: Deps): ScheduledTask[] {
  return [
    {
      name: "inference-sweep",
      async run() {
        const now = deps.clock.now();
        const due = await deps.stores.sweeps.due(now, SWEEPS_PER_RUN);
        for (const accountId of due) {
          try {
            await sweepAccount(deps, accountId);
          } catch {
            // Named only: an error message could carry request-derived text. The account is due again next run.
            console.error("inference-sweep failed for one account");
          }
        }
      },
    },
    {
      name: "inference-expire",
      async run() {
        const now = deps.clock.now();
        await deps.stores.idempotency.deleteExpired(now);
        await deps.stores.rateLimits.deleteExpired(now);
      },
    },
  ];
}
