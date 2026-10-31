// Completing a sign-in: the device slot, the single use of the code, the session and the tokens.
//
// Order (docs/cloud-api.md, and the follow-up flow documented on `AuthChallengeStore.verifyEmailCode`):
//   1. register the device (the atomic 3-device limit check and insert);
//   2. consume the pending sign-in (single use);
//   3. if the consume lost a race, roll the device back, so two parallel redemptions of one code cannot leave
//      two devices behind;
//   4. only then create the session and mint tokens.

import { randomToken } from "../../crypto/random";
import type { Deps } from "../../deps";
import { ApiError } from "../../http/envelope";
import type { AccountRecord } from "../../storage";
import type { TokenResponse } from "../../types";
import { DEVICE_PRUNE_GRACE_MS } from "./constants";
import { buildTokenResponse, createSession } from "./sessions";

export type SignInResult = { kind: "tokens"; response: TokenResponse } | { kind: "device_limit" };

export const DEFAULT_DEVICE_LABEL = "Unknown device";

export function cleanDeviceLabel(label: string | undefined | null): string {
  const cleaned = (label ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64);
  return cleaned === "" ? DEFAULT_DEVICE_LABEL : cleaned;
}

/**
 * Removes devices whose sessions are all gone (revoked or expired). A device is freed when its session expires
 * (30 days idle), which is how a Google-only user at the limit eventually gets a slot. A device younger than a
 * minute is left alone: the sign-in that just created it has not made its session yet.
 */
export async function pruneDevicesWithoutSession(deps: Deps, accountId: string): Promise<number> {
  const { devices, sessions } = deps.stores;
  const now = deps.clock.now();
  const [list, active] = await Promise.all([devices.list(accountId), sessions.listActiveByAccount(accountId, now)]);
  const withSession = new Set(active.map((s) => s.deviceId));
  let pruned = 0;
  for (const d of list) {
    if (withSession.has(d.deviceId) || now - d.lastUsedAt < DEVICE_PRUNE_GRACE_MS) continue;
    if (await devices.revoke(accountId, d.deviceId)) pruned++;
  }
  return pruned;
}

/**
 * `pendingId` is the pending sign-in that this redemption spends. A client-supplied `device_id` is honored only
 * if it already belongs to this account; otherwise a new id is created.
 */
export async function completeSignIn(
  deps: Deps,
  input: { account: AccountRecord; pendingId: string; deviceId: string | undefined; deviceLabel: string | undefined | null },
): Promise<SignInResult> {
  const { devices, sessions, authChallenges, accounts } = deps.stores;
  const now = deps.clock.now();
  const accountId = input.account.accountId;

  let deviceId = input.deviceId;
  if (deviceId === undefined || !(await devices.get(accountId, deviceId))) deviceId = randomToken("dev_", 16);
  const registration = { accountId, deviceId, label: cleanDeviceLabel(input.deviceLabel), now };

  let registered = await devices.register(registration);
  if (!registered.ok && registered.reason === "device_limit_reached") {
    if ((await pruneDevicesWithoutSession(deps, accountId)) > 0) registered = await devices.register(registration);
  }
  if (!registered.ok) {
    if (registered.reason === "device_limit_reached") return { kind: "device_limit" };
    // An id we just generated cannot be taken by another account except by astronomically bad luck.
    throw new Error("device id collision");
  }

  const consumed = await authChallenges.consume(input.pendingId, now);
  if (!consumed) {
    if (registered.created) await devices.revoke(accountId, deviceId);
    throw new ApiError("invalid_code");
  }

  // A fresh sign-in on a known device replaces that device's earlier session family.
  if (!registered.created) await sessions.revokeByDevice(accountId, deviceId, now);
  const { session, refreshToken } = await createSession(deps, { accountId, deviceId });
  await devices.incrementNewSessions(accountId, new Date(now).toISOString().slice(0, 10));
  // A deletion that started while this sign-in was running must not leave a device or a session behind.
  if (!(await accounts.getById(accountId))) {
    await sessions.revokeFamily(session.familyId, now);
    await sessions.purgeAccount(accountId);
    await devices.purgeAccount(accountId);
    throw new ApiError("invalid_code");
  }
  await accounts.update(accountId, { lastSignInAt: now });
  // A manage token only exists to get a sign-in through the device limit; it has done its job.
  await devices.revokeManageTokens(accountId);
  return { kind: "tokens", response: await buildTokenResponse(deps, { account: input.account, session, refreshToken }) };
}
