// Account deletion. The decided model: ERASE ALL PERSONAL DATA WHEN THE TOMBSTONE IS CREATED.
//
// `DELETE /v1/account` (1) sends the final notification email, (2) turns the account into a tombstone that keeps
// only the Paddle ids and the retry bookkeeping (the account row, the email and Google indexes and the plan are
// gone), and (3) erases everything else keyed by the account: sessions, devices, consents, pending sign-ins,
// ledger and idempotency records, leases. The sessions die with the account, so a repeated DELETE answers
// `session_revoked`, which the client treats as "done".
//
// What remains is only the cancel of the Paddle subscription. It is tried at once and then retried by the cron job
// with backoff for a bounded period (`DELETION_RETRY_PERIOD_MS`, a placeholder); the operator is alerted when it
// keeps failing and again when the period ran out, after which the deletion waits in manual review. The tombstone
// is removed as soon as the cancel succeeded (or there was nothing to cancel).

import { base64urlEncode } from "../../crypto/encoding";
import { hmacSha256 } from "../../crypto/hash";
import type { Deps } from "../../deps";
import type { ScheduledTask } from "../../scheduled";
import { emailLookupHash } from "../auth/codes";
import { billingSeam, inferenceSeam } from "./seams";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BACKOFF_CAP_MS = 6 * 60 * MINUTE;
/** After this many failed or pending cancels the operator is alerted (and keeps being, on each further attempt). */
export const ALERT_AFTER_ATTEMPTS = 5;
/** Placeholder: how long the cancel is retried before the deletion goes to manual review. */
export const DELETION_RETRY_PERIOD_MS = 14 * DAY;
const RETRY_BATCH = 25;

/** Stable per deletion: the same value for the life of the tombstone, unrelated to anything the client could guess. */
export async function deletionId(deps: Deps, accountId: string, createdAt: number): Promise<string> {
  const key = deps.config.secret("CODE_HMAC_KEY").reveal();
  return `del_${base64urlEncode(await hmacSha256(key, `deletion:${accountId}:${createdAt}`)).slice(0, 22)}`;
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, MINUTE * 2 ** Math.min(attempts, 10));
}

/**
 * Erases every record keyed by the account id, except the tombstone. Idempotent and safe to repeat (the retry job
 * repeats it, so a crash between the tombstone and this erasure is repaired).
 */
export async function eraseAccountData(deps: Deps, accountId: string): Promise<void> {
  const { stores } = deps;
  await deps.auth.revokeAllSessions(accountId);
  await deps.auth.revokeManageTokens(accountId);
  await inferenceSeam(deps).purgeLedger(accountId);
  for (const store of [stores.sessions, stores.devices, stores.consents, stores.ledger, stores.idempotency, stores.authChallenges, stores.concurrency]) {
    await store.purgeAccount(accountId);
  }
  await stores.sweeps.clear(accountId);
}

/** Drops the pending email sign-in of an address (it is keyed by a hash of the address, not by the account id). */
export async function erasePendingSignIn(deps: Deps, email: string): Promise<void> {
  const codeKey = deps.config.secret("CODE_HMAC_KEY").reveal();
  const pending = await deps.stores.authChallenges.getByEmailHash(await emailLookupHash(codeKey, email), deps.clock.now());
  if (pending) await deps.stores.authChallenges.delete(pending.id);
}

/**
 * One attempt at finishing a deletion: erase what is left (idempotent), cancel at Paddle, and when that is done (or
 * there was nothing to cancel) remove the tombstone. Returns whether the tombstone is gone. A cancel that is still
 * pending or throws is counted and rescheduled with backoff; past the retry period the deletion goes to manual review.
 * `attemptsSoFar` is the count already on the tombstone (0 for the first attempt, made by the DELETE itself).
 */
export async function attemptDeletion(deps: Deps, accountId: string, createdAt: number, attemptsSoFar = 0): Promise<boolean> {
  const now = deps.clock.now();
  await eraseAccountData(deps, accountId);
  let state: "cancelled" | "pending" | "none" | "error";
  try {
    state = (await billingSeam(deps).cancelSubscription(accountId, "now")).state;
  } catch {
    state = "error";
  }
  if (state === "cancelled" || state === "none") {
    await deps.stores.accounts.purgeAccount(accountId);
    return true;
  }
  const attempts = attemptsSoFar + 1;
  if (now - createdAt >= DELETION_RETRY_PERIOD_MS) {
    await deps.stores.accounts.markDeletionManual(accountId);
    deps.account.alertOperator("deletion_needs_manual_review");
    return false;
  }
  await deps.stores.accounts.recordCancelAttempt(accountId, now + backoffMs(attempts));
  if (attempts >= ALERT_AFTER_ATTEMPTS) deps.account.alertOperator("deletion_cancel_failing");
  return false;
}

/** The deletion retry job: every tombstone whose backoff has passed (and that is not in manual review) gets another attempt. */
export function createDeletionRetryTask(deps: Deps): ScheduledTask {
  return {
    name: "account-deletion-retry",
    async run() {
      const due = await deps.stores.accounts.listDueDeletions(deps.clock.now(), RETRY_BATCH);
      for (const job of due) await attemptDeletion(deps, job.tombstone.accountId, job.tombstone.createdAt, job.cancelAttempts);
    },
  };
}
