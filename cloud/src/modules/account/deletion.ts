// Account deletion (docs/cloud-plan.md, Payments > 5): the account becomes a `deleting` tombstone that keeps only
// the Paddle ids, the subscription is cancelled (retried with backoff, with an operator alert on repeated failure),
// and only when the cancel succeeded is everything purged.
//
// While the account is `deleting` its sessions stay valid so that a repeated DELETE /v1/account can return the
// same 202 (it is naturally idempotent); every gated route answers `session_revoked` meanwhile (see hooks.ts).
// The sessions die with the purge.

import { base64urlEncode } from "../../crypto/encoding";
import { hmacSha256 } from "../../crypto/hash";
import type { Deps } from "../../deps";
import type { ScheduledTask } from "../../scheduled";
import { billingSeam, inferenceSeam } from "./seams";

const MINUTE = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;
/** After this many failed or pending cancels the operator is alerted (and keeps being, on each further attempt). */
export const ALERT_AFTER_ATTEMPTS = 5;
const RETRY_BATCH = 25;

/** Stable per deletion: the same value for a repeated call, unrelated to anything the client could guess. */
export async function deletionId(deps: Deps, accountId: string, createdAt: number): Promise<string> {
  const key = deps.config.secret("CODE_HMAC_KEY").reveal();
  return `del_${base64urlEncode(await hmacSha256(key, `deletion:${accountId}:${createdAt}`)).slice(0, 22)}`;
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, MINUTE * 2 ** Math.min(attempts, 10));
}

/** Removes every record of the account from every store. The account row goes last. */
export async function purgeEverything(deps: Deps, accountId: string): Promise<void> {
  const { stores } = deps;
  await deps.auth.revokeAllSessions(accountId);
  await deps.auth.revokeManageTokens(accountId);
  await inferenceSeam(deps).purgeLedger(accountId);
  for (const store of [stores.sessions, stores.devices, stores.consents, stores.ledger, stores.idempotency, stores.authChallenges, stores.concurrency]) {
    await store.purgeAccount(accountId);
  }
  await stores.sweeps.clear(accountId);
  await stores.accounts.purgeAccount(accountId);
}

/**
 * One attempt at finishing a deletion: cancel at Paddle, and when that is done (or there was nothing to cancel),
 * purge. Returns whether the account was purged. A cancel that is still pending or throws is counted and
 * rescheduled with backoff, and alerts the operator once it has failed `ALERT_AFTER_ATTEMPTS` times.
 * `attemptsSoFar` is the count already on the tombstone (0 for the first attempt, made by the DELETE itself).
 */
export async function attemptDeletion(deps: Deps, accountId: string, attemptsSoFar = 0): Promise<boolean> {
  let state: "cancelled" | "pending" | "none" | "error";
  try {
    state = (await billingSeam(deps).cancelSubscription(accountId, "now")).state;
  } catch {
    state = "error";
  }
  if (state === "cancelled" || state === "none") {
    await purgeEverything(deps, accountId);
    return true;
  }
  const attempts = attemptsSoFar + 1;
  await deps.stores.accounts.recordCancelAttempt(accountId, deps.clock.now() + backoffMs(attempts));
  if (attempts >= ALERT_AFTER_ATTEMPTS) deps.account.alertOperator("deletion_cancel_failing");
  return false;
}

/** The deletion retry job: every tombstone whose backoff has passed gets another attempt. */
export function createDeletionRetryTask(deps: Deps): ScheduledTask {
  return {
    name: "account-deletion-retry",
    async run() {
      const due = await deps.stores.accounts.listDueDeletions(deps.clock.now(), RETRY_BATCH);
      for (const job of due) await attemptDeletion(deps, job.tombstone.accountId, job.cancelAttempts);
    },
  };
}
