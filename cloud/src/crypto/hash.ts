import { base64urlEncode, hexEncode, toBytes, type BytesLike } from "./encoding";
import { constantTimeEqual } from "./compare";

// crypto.subtle only. Works unchanged on Workers and Node 22.

// Copy into a fresh ArrayBuffer-backed view so the BufferSource type is always satisfied.
function buf(value: BytesLike): Uint8Array<ArrayBuffer> {
  const bytes = toBytes(value);
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

export async function sha256(data: BytesLike): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(data)));
}

export async function sha256Hex(data: BytesLike): Promise<string> {
  return hexEncode(await sha256(data));
}

export async function sha256Base64Url(data: BytesLike): Promise<string> {
  return base64urlEncode(await sha256(data));
}

async function hmacKey(key: BytesLike, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function hmacSha256(key: BytesLike, data: BytesLike): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), buf(data)));
}

export async function hmacSha256Hex(key: BytesLike, data: BytesLike): Promise<string> {
  return hexEncode(await hmacSha256(key, data));
}

export async function hmacSha256Base64Url(key: BytesLike, data: BytesLike): Promise<string> {
  return base64urlEncode(await hmacSha256(key, data));
}

/** Verifies an HMAC-SHA-256 tag with the platform's constant-time verify. */
export async function verifyHmacSha256(key: BytesLike, data: BytesLike, tag: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), buf(tag), buf(data));
}

/** Compares a hex digest with an expected one in constant time (for example a webhook signature). */
export function constantTimeEqualHex(a: string, b: string): boolean {
  return constantTimeEqual(a.toLowerCase(), b.toLowerCase());
}
