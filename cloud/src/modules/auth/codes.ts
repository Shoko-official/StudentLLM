// Hashing and normalization helpers for emails, one-time codes, PKCE and opaque tokens.

import { constantTimeEqual } from "../../crypto/compare";
import { sha256Base64Url, sha256Hex, hmacSha256Base64Url } from "../../crypto/hash";
import { stableKeyedHash, type StableHash } from "../../crypto/keyed-hash";
import { CODE_ALPHABET, randomCode } from "../../crypto/random";
import { BASE64URL_43_128, PKCE_VERIFIER } from "./validate";
import { EMAIL_CODE_LENGTH } from "./constants";

/**
 * Lower-cases the address and converts the domain to its ASCII form. The `+` tag and the dots are kept
 * (`a.b@x.com` and `ab+c@x.com` are different addresses). Returns null for anything that is not a plain
 * `local@domain` address of at most 254 characters.
 */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 254) return null;
  const at = value.lastIndexOf("@");
  if (at < 1 || at !== value.indexOf("@")) return null;
  const local = value.slice(0, at).toLowerCase();
  const domain = value.slice(at + 1);
  if (local.length > 64 || !/^[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+$/.test(local)) return null;
  if (domain.length === 0 || domain.length > 253 || !/^[^\s/\\?#@:%[\]\u0000-\u001f\u007f]+$/.test(domain)) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${domain}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ascii) || ascii.split(".").some((l) => l.length > 63 || l.startsWith("-") || l.endsWith("-"))) {
    return null;
  }
  if (/^[0-9.]+$/.test(ascii)) return null; // an IPv4 literal is not a mail domain
  const normalized = `${local}@${ascii}`;
  return normalized.length <= 254 ? normalized : null;
}

/** The 8-character one-time code, from an alphabet without look-alike characters (about 40 bits). */
export function newEmailCode(): string {
  return randomCode(CODE_ALPHABET, EMAIL_CODE_LENGTH);
}

/** What the user typed, folded to the alphabet's case. */
export function canonicalCode(typed: string): string {
  return typed.toUpperCase();
}

export function emailLookupHash(codeKey: string, email: string): Promise<StableHash> {
  return stableKeyedHash(codeKey, "email", email);
}

/**
 * The stored form of an email code: a keyed HMAC over the address, the code and the PKCE challenge of the
 * request that asked for it. Binding the challenge here (instead of checking it after the store said "ok")
 * means that the right code with the wrong `code_verifier` is just a wrong guess: it counts as an attempt in
 * the same atomic step, and it cannot be retried for free.
 */
export function emailCodeHash(codeKey: string, email: string, code: string, codeChallenge: string): Promise<string> {
  return hmacSha256Base64Url(codeKey, `email-code:${email}:${canonicalCode(code)}:${codeChallenge}`);
}

/** The stored form of the single-use authorization code handed to the app after the Google callback. */
export function googleAuthCodeHash(codeKey: string, code: string): Promise<string> {
  return hmacSha256Base64Url(codeKey, `google-auth-code:${code}`);
}

/** `S256` challenge of a verifier: BASE64URL(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

export function isPkceVerifier(value: string): boolean {
  return PKCE_VERIFIER.test(value);
}

export function isPkceChallenge(value: string): boolean {
  return BASE64URL_43_128.test(value);
}

/** True when the verifier hashes to the challenge (constant time). */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  return constantTimeEqual(await pkceChallenge(verifier), challenge);
}

/** SHA-256 (hex) of an opaque random token: refresh token, manage token, link ticket. */
export function tokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}
