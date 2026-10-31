// Small encoding helpers on Web-standard APIs only (TextEncoder, btoa/atob).

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type BytesLike = Uint8Array | string;

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Strict UTF-8 decode: throws on invalid sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toBytes(value: BytesLike): Uint8Array {
  return typeof value === "string" ? utf8Encode(value) : value;
}

export function base64urlEncode(input: BytesLike): string {
  const bytes = toBytes(input);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Strict, canonical base64url decode: no padding, URL-safe alphabet only, and the text must be exactly what
 * `base64urlEncode` would produce (non-zero trailing bits are refused). Throws RangeError on bad input.
 */
export function base64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new RangeError("invalid base64url");
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (base64urlEncode(out) !== text) throw new RangeError("non-canonical base64url");
  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
