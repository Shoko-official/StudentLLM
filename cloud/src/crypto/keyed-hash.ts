import { base64urlEncode, type BytesLike } from "./encoding";
import { hmacSha256 } from "./hash";

/** Counters expire after 24 hours, so the salt rotates every 24 hours (docs/cloud-plan.md, sign-in counters). */
export const DEFAULT_SALT_ROTATION_MS = 24 * 60 * 60 * 1000;

export interface KeyedHashOptions {
  /** Epoch length in ms. Default: 24 hours. */
  rotationMs?: number;
}

export function saltEpoch(nowMs: number, rotationMs = DEFAULT_SALT_ROTATION_MS): number {
  return Math.floor(nowMs / rotationMs);
}

/**
 * Keyed hash of `value` under the salt of one epoch. The salt of an epoch is HMAC(masterKey, epoch), so
 * nothing but the master secret is stored and old salts cannot be recomputed without it. `purpose`
 * separates counters (for example `email` and `conn`) so the same input never collides across uses.
 * Use it for sign-in and rate-limit counters keyed by an email or connection address. The raw value is
 * never stored.
 */
export async function keyedHashAtEpoch(
  masterKey: BytesLike,
  purpose: string,
  value: string,
  epoch: number,
): Promise<string> {
  if (!/^[a-z][a-z0-9_-]*$/.test(purpose)) throw new RangeError("invalid purpose");
  const salt = await hmacSha256(masterKey, `salt:${epoch}`);
  return base64urlEncode(await hmacSha256(salt, `${purpose}:${value}`));
}

export interface RotatingHash {
  epoch: number;
  hash: string;
}

/** Hash under the current salt. Store the counter under `hash` with a TTL of one rotation period or more. */
export async function rotatingKeyedHash(
  masterKey: BytesLike,
  purpose: string,
  value: string,
  nowMs: number,
  options: KeyedHashOptions = {},
): Promise<RotatingHash> {
  const epoch = saltEpoch(nowMs, options.rotationMs);
  return { epoch, hash: await keyedHashAtEpoch(masterKey, purpose, value, epoch) };
}

/**
 * Hashes under the current and the previous salt, so a lookup right after a rotation still finds a
 * counter written just before it.
 */
export async function rotatingKeyedHashes(
  masterKey: BytesLike,
  purpose: string,
  value: string,
  nowMs: number,
  options: KeyedHashOptions = {},
): Promise<{ current: RotatingHash; previous: RotatingHash }> {
  const epoch = saltEpoch(nowMs, options.rotationMs);
  return {
    current: { epoch, hash: await keyedHashAtEpoch(masterKey, purpose, value, epoch) },
    previous: { epoch: epoch - 1, hash: await keyedHashAtEpoch(masterKey, purpose, value, epoch - 1) },
  };
}
