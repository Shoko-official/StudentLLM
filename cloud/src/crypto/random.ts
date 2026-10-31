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
