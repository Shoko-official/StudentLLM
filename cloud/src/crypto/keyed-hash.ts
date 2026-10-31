import { base64urlEncode, type BytesLike } from "./encoding";
import { hmacSha256 } from "./hash";

/** Counters expire after 24 hours, so the salt rotates every 24 hours (docs/cloud-plan.md, sign-in counters). */
export const DEFAULT_SALT_ROTATION_MS = 24 * 60 * 60 * 1000;

/**
 * A hash under a ROTATING salt. Only for counters that expire (sign-in and rate-limit counters keyed by an
 * email or connection address). It must not be used as a lookup key that has to survive a rotation.
 */
export type SaltedHash = string & { readonly __brand: "SaltedHash" };

/**
 * A hash under a NON-rotating key (`CODE_HMAC_KEY`), stable for the life of the record. Use it for lookups
 * that must survive the 24-hour rotation, for example the pending email sign-in (valid 10 minutes).
 */
export type StableHash = string & { readonly __brand: "StableHash" };

export interface KeyedHashOptions {
  /** Epoch length in ms. Default: 24 hours. */
  rotationMs?: number;
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}

export function saltEpoch(nowMs: number, rotationMs = DEFAULT_SALT_ROTATION_MS): number {
  assertSafeInteger(nowMs, "time");
  assertSafeInteger(rotationMs, "rotation period");
  if (rotationMs < 1) throw new RangeError("rotation period must be positive");
  return Math.floor(nowMs / rotationMs);
}

function assertPurpose(purpose: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(purpose)) throw new RangeError("invalid purpose");
}

/**
 * Keyed hash of `value` under the salt of one epoch. The salt of an epoch is HMAC(masterKey, epoch), so
 * nothing but the master secret is stored and old salts cannot be recomputed without it. `purpose`
 * separates counters (for example `email` and `conn`) so the same input never collides across uses.
 * The raw value is never stored.
 */
export async function keyedHashAtEpoch(
  masterKey: BytesLike,
  purpose: string,
  value: string,
  epoch: number,
): Promise<SaltedHash> {
  assertPurpose(purpose);
  assertSafeInteger(epoch, "epoch");
  const salt = await hmacSha256(masterKey, `salt:${epoch}`);
  return base64urlEncode(await hmacSha256(salt, `${purpose}:${value}`)) as SaltedHash;
}

/** Non-rotating keyed hash, for lookups that must stay valid (see `StableHash`). */
export async function stableKeyedHash(key: BytesLike, purpose: string, value: string): Promise<StableHash> {
  assertPurpose(purpose);
  return base64urlEncode(await hmacSha256(key, `stable:${purpose}:${value}`)) as StableHash;
}

export interface RotatingHash {
  epoch: number;
  hash: SaltedHash;
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
