// Cron work of the billing module (see src/scheduled.ts).

import type { Deps } from "../../deps";
import type { ScheduledTask } from "../../scheduled";
import { retryPendingCancels } from "./cancel";
import { envFromDeps } from "./env";

export function billingScheduledTasks(deps: Deps): ScheduledTask[] {
  return [
    {
      // A cancellation Paddle did not confirm is retried until it succeeds (docs/cloud-plan.md, "Payments", item 5).
      name: "billing.retry-cancellations",
      async run() {
        await retryPendingCancels(envFromDeps(deps));
      },
    },
    {
      // The webhook ledger keeps events for the retention period only.
      name: "billing.prune-webhook-ledger",
      async run() {
        const env = envFromDeps(deps);
        await env.stores.webhookEvents.deleteOlderThan(env.clock.now() - env.settings.webhookRetentionMs);
      },
    },
  ];
}
