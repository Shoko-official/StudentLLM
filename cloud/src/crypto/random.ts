import { base64urlEncode } from "./encoding";

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 1024) {
    throw new RangeError("random length must be an integer between 1 and 1024");
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

const PREFIX = /^[a-z][a-z0-9]{0,7}_$/;

/**
 * Random opaque token with a type prefix, for example `randomToken("mt_")` for a manage token or
 * `randomToken("rt_")` for a refresh token. The default is 32 random bytes (256 bits).
 */
export function randomToken(prefix: string, bytes = 32): string {
  if (!PREFIX.test(prefix)) throw new RangeError("token prefix must look like `mt_`");
  if (bytes < 16) throw new RangeError("a token needs at least 128 bits");
  return prefix + base64urlEncode(randomBytes(bytes));
}

/** 32 characters without look-alikes (no I, O, 0, 1): 5 bits each, so 8 characters carry 40 bits. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Random string over `alphabet` by rejection sampling, so every character is uniform even when the
 * alphabet size does not divide 256 (a plain `byte % size` would favor the first characters).
 */
export function randomCode(alphabet: string, length: number): string {
  const size = alphabet.length;
  if (size < 2 || size > 256 || new Set(alphabet).size !== size) {
    throw new RangeError("alphabet must hold 2 to 256 distinct characters");
  }
  if (!Number.isInteger(length) || length < 1 || length > 128) throw new RangeError("invalid code length");
  const limit = 256 - (256 % size); // bytes at or above this would bias the result
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(Math.max(16, (length - out.length) * 2))) {
      if (byte < limit && out.length < length) out += alphabet[byte % size];
    }
  }
  return out;
}
