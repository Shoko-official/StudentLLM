// Sessions: minting tokens, refresh rotation with the retry grace window and reuse detection, logout.
//
// Refresh tokens are opaque (`rt_` + 256 random bits) and stored as SHA-256 only. A rotation keeps the hash of
// the previous token and, for the grace window, the successor encrypted under a key derived from the previous
// token (AES-GCM, bound to the session family), so that a client which lost the response can present the
// previous token again within 30 seconds and get the SAME successor. Any other use of a rotated token revokes
// the whole family (`refresh_reuse`).

import { constantTimeEqual } from "../../crypto/compare";
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from "../../crypto/encoding";
import { sha256 } from "../../crypto/hash";
import { randomBytes, randomToken } from "../../crypto/random";
import type { Deps } from "../../deps";
import { ApiError } from "../../http/envelope";
import type { AccountRecord, SessionRecord } from "../../storage";
import type { TokenResponse } from "../../types";
import { buf } from "./bytes";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_ABSOLUTE_MS, REFRESH_GRACE_MS, REFRESH_IDLE_MS } from "./constants";
import { tokenHash } from "./codes";
import { planLabel } from "./plan";
import { accessTokenClaims, signAccessToken } from "./tokens";

// ---------------------------------------------------------------------------------------------------
// Grace window encryption
// ---------------------------------------------------------------------------------------------------

async function graceKey(previousToken: string): Promise<CryptoKey> {
  const material = await sha256(utf8Encode(`studentllm/refresh-grace/v1\0${previousToken}`));
  return crypto.subtle.importKey("raw", buf(material), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts the successor under a key derived from the previous token. Output: base64url(iv || ciphertext+tag). */
export async function encryptGraceSuccessor(previousToken: string, successor: string, familyId: string): Promise<string> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8Encode(familyId)) },
      await graceKey(previousToken),
      buf(utf8Encode(successor)),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return base64urlEncode(out);
}

/** Returns the successor, or null when the ciphertext does not open with this previous token. */
export async function decryptGraceSuccessor(previousToken: string, stored: string, familyId: string): Promise<string | null> {
  try {
    const bytes = base64urlDecode(stored);
    if (bytes.length < 12 + 16) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(bytes.slice(0, 12)), additionalData: buf(utf8Encode(familyId)) },
      await graceKey(previousToken),
      buf(bytes.slice(12)),
    );
    return utf8Decode(new Uint8Array(plain));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Token responses
// ---------------------------------------------------------------------------------------------------

export function newRefreshToken(): string {
  return randomToken("rt_");
}

export async function buildTokenResponse(
  deps: Deps,
  input: { account: AccountRecord; session: SessionRecord; refreshToken: string },
): Promise<TokenResponse> {
  const now = deps.clock.now();
  const keys = await deps.auth.keys();
  const claims = accessTokenClaims({
    issuer: deps.config.issuer,
    audience: deps.config.audience,
    accountId: input.account.accountId,
    sessionId: input.session.familyId,
    deviceId: input.session.deviceId,
    authTimeSeconds: Math.floor(input.session.authTime / 1000),
    nowSeconds: Math.floor(now / 1000),
    tokenId: randomToken("jti_", 16),
  });
  const plan = await deps.stores.accounts.getPlan(input.account.accountId);
  return {
    access_token: await signAccessToken(keys, claims),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: input.refreshToken,
    device_id: input.session.deviceId,
    account: { account_id: input.account.accountId, email: input.account.email, plan: planLabel(plan, now) },
  };
}

/** A brand new session family for a device that was just registered. `authTime` is the moment of this sign-in. */
export async function createSession(
  deps: Deps,
  input: { accountId: string; deviceId: string },
): Promise<{ session: SessionRecord; refreshToken: string }> {
  const now = deps.clock.now();
  const refreshToken = newRefreshToken();
  const session: SessionRecord = {
    familyId: randomToken("fam_", 16),
    accountId: input.accountId,
    deviceId: input.deviceId,
    currentHash: await tokenHash(refreshToken),
    prevHash: null,
    rotatedAt: null,
    graceSuccessor: null,
    authTime: now,
    createdAt: now,
    lastUsedAt: now,
    idleExpiresAt: now + REFRESH_IDLE_MS,
    absoluteExpiresAt: now + REFRESH_ABSOLUTE_MS,
    revokedAt: null,
  };
  await deps.stores.sessions.create(session);
  return { session, refreshToken };
}

// ---------------------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------------------

const revoked = () => new ApiError("session_revoked");

/**
 * Rotates the refresh token. Failure modes, all 401:
 * - unknown token, wrong device, revoked or expired family, deleted account: `session_revoked`;
 * - the previous token again outside the grace window, or after its successor was used: `refresh_reuse`, and
 *   the family is revoked.
 * `auth_time` is copied from the session and never renewed here.
 */
export async function refreshSession(deps: Deps, input: { refreshToken: string; deviceId: string }): Promise<TokenResponse> {
  const { sessions, devices, accounts } = deps.stores;
  const now = deps.clock.now();
  const hash = await tokenHash(input.refreshToken);
  const found = await sessions.findByTokenHash(hash);
  if (!found) throw revoked();
  const { session } = found;
  // The device id must be the one this family was issued to. A mismatch is refused without revoking: the
  // token holder may simply not know the id, and revoking would let anyone with a guess lock a user out.
  if (!constantTimeEqual(session.deviceId, input.deviceId)) throw revoked();
  if (session.revokedAt !== null) throw revoked();
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
    await sessions.revokeFamily(session.familyId, now);
    throw revoked();
  }
  if (!(await devices.isActive(session.accountId, session.deviceId))) {
    await sessions.revokeFamily(session.familyId, now);
    throw revoked();
  }
  const account = await accounts.getById(session.accountId);
  if (!account || account.status === "deleting") throw revoked();

  let match = found.match;
  let current = session;
  if (match === "current") {
    const successor = newRefreshToken();
    const rotated = await sessions.rotate(session.familyId, hash, {
      newHash: await tokenHash(successor),
      graceSuccessor: await encryptGraceSuccessor(input.refreshToken, successor, session.familyId),
      now,
      idleExpiresAt: Math.min(now + REFRESH_IDLE_MS, session.absoluteExpiresAt),
    });
    if (rotated) {
      await devices.touch(session.accountId, session.deviceId, now);
      return buildTokenResponse(deps, { account, session: rotated, refreshToken: successor });
    }
    // Another request rotated first. This token is now the previous one: look again and take the grace path,
    // so parallel refreshes with one token all get the winner's successor and exactly one rotation happened.
    const again = await sessions.findByTokenHash(hash);
    if (!again || again.session.revokedAt !== null) throw revoked();
    match = again.match;
    current = again.session;
    if (match === "current") throw new Error("a rotation was lost but the token is still current");
  }

  // The previous token: allowed once, within the grace window, while the successor is still unused.
  const stillGrace = current.rotatedAt !== null && now - current.rotatedAt <= REFRESH_GRACE_MS && current.graceSuccessor !== null;
  const successor = stillGrace ? await decryptGraceSuccessor(input.refreshToken, current.graceSuccessor!, current.familyId) : null;
  if (successor === null) {
    await sessions.revokeFamily(current.familyId, now);
    throw new ApiError("refresh_reuse");
  }
  return buildTokenResponse(deps, { account, session: current, refreshToken: successor });
}

// ---------------------------------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------------------------------

/**
 * Revokes the family of the presented token, current or previous, and frees the device when no other active
 * session uses it. Idempotent: an unknown token is a quiet success, so a logout can always be retried.
 */
export async function logoutSession(deps: Deps, refreshToken: string): Promise<void> {
  const { sessions, devices } = deps.stores;
  const now = deps.clock.now();
  const found = await sessions.findByTokenHash(await tokenHash(refreshToken));
  if (!found) return;
  const { accountId, deviceId, familyId } = found.session;
  await sessions.revokeFamily(familyId, now);
  const others = await sessions.listActiveByAccount(accountId, now);
  if (!others.some((s) => s.deviceId === deviceId)) await devices.revoke(accountId, deviceId);
}
