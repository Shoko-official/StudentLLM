// Access tokens: Ed25519 JWTs (`alg` pinned to EdDSA), the signing keys and the JWKS.
//
// Keys. `TOKEN_SIGNING_KEY` (PKCS8, base64) signs. The `kid` is the RFC 7638 thumbprint of the public key, so it
// follows the key and nothing has to be configured. To rotate: set the new private key as TOKEN_SIGNING_KEY and
// put the OLD public key (base64url `x`) into the `TOKEN_PREVIOUS_PUBLIC_KEYS` variable; both appear in the JWKS
// and tokens signed by either verify until the old key is removed from the variable (keep it for at least the
// access token lifetime plus the JWKS cache time: 20 minutes).

import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from "../../crypto/encoding";
import { sha256 } from "../../crypto/hash";
import { buf } from "./bytes";
import { ACCESS_TOKEN_TTL_SECONDS } from "./constants";

export interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  did: string;
  auth_time: number;
  iat: number;
  exp: number;
  jti: string;
}

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  kid: string;
  x: string;
  alg: "EdDSA";
  use: "sig";
}

export interface TokenKeys {
  /** `kid` of the signing key. */
  readonly kid: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** Public keys by `kid`: the signing key and the previous ones. */
  readonly verifyKeys: ReadonlyMap<string, CryptoKey>;
  readonly jwks: { keys: PublicJwk[] };
}

const ED25519 = { name: "Ed25519" } as const;

async function thumbprint(x: string): Promise<string> {
  // RFC 7638: members in lexicographic order, no whitespace.
  const digest = await sha256(utf8Encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`));
  return base64urlEncode(digest).slice(0, 22);
}

async function publicKeyFromX(x: string): Promise<{ jwk: PublicJwk; key: CryptoKey }> {
  const raw = base64urlDecode(x);
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  const key = await crypto.subtle.importKey("raw", buf(raw), ED25519, false, ["verify"]);
  return { jwk: { kty: "OKP", crv: "Ed25519", kid: await thumbprint(x), x, alg: "EdDSA", use: "sig" }, key };
}

/** Imports the signing key and the previous public keys. Throws a generic error that never carries key material. */
export async function loadTokenKeys(privateKeyPkcs8Base64: string, previousPublicKeys: readonly string[] = []): Promise<TokenKeys> {
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(privateKeyPkcs8Base64.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("the token signing key is not valid base64");
  }
  let x: string;
  let signingKey: CryptoKey;
  try {
    // Extractable only to read the public half; the key that signs is imported again as non-extractable.
    const probe = await crypto.subtle.importKey("pkcs8", buf(der), ED25519, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", probe);
    if (typeof jwk.x !== "string") throw new Error("no public key");
    x = jwk.x;
    signingKey = await crypto.subtle.importKey("pkcs8", buf(der), ED25519, false, ["sign"]);
  } catch {
    throw new Error("the token signing key is not a PKCS8 Ed25519 key");
  }
  const current = await publicKeyFromX(x);
  const verifyKeys = new Map<string, CryptoKey>([[current.jwk.kid, current.key]]);
  const keys: PublicJwk[] = [current.jwk];
  for (const previous of previousPublicKeys) {
    const entry = await publicKeyFromX(previous);
    if (verifyKeys.has(entry.jwk.kid)) continue;
    verifyKeys.set(entry.jwk.kid, entry.key);
    keys.push(entry.jwk);
  }
  return {
    kid: current.jwk.kid,
    async sign(data) {
      return new Uint8Array(await crypto.subtle.sign(ED25519, signingKey, buf(data)));
    },
    verifyKeys,
    jwks: { keys },
  };
}

/** Parses the `TOKEN_PREVIOUS_PUBLIC_KEYS` variable: base64url public keys separated by commas or spaces. */
export function parsePreviousPublicKeys(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export async function signAccessToken(keys: TokenKeys, claims: AccessTokenClaims): Promise<string> {
  const header = base64urlEncode(utf8Encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: keys.kid })));
  const payload = base64urlEncode(utf8Encode(JSON.stringify(claims)));
  const signature = await keys.sign(utf8Encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64urlEncode(signature)}`;
}

export function accessTokenClaims(input: {
  issuer: string;
  audience: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  authTimeSeconds: number;
  nowSeconds: number;
  tokenId: string;
}): AccessTokenClaims {
  return {
    iss: input.issuer,
    aud: input.audience,
    sub: input.accountId,
    sid: input.sessionId,
    did: input.deviceId,
    auth_time: input.authTimeSeconds,
    iat: input.nowSeconds,
    exp: input.nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    jti: input.tokenId,
  };
}

const MAX_TOKEN_LENGTH = 2048;
const CLOCK_SKEW_SECONDS = 60;
const MAX_LIFETIME_SECONDS = 3600;

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(utf8Decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Verifies a compact JWT. Returns the claims, or null for ANY problem (the caller answers `invalid_token`
 * without saying which): wrong shape, an `alg` other than exactly `EdDSA` (so `none`, HS256 and the rest are
 * refused before any key is touched), an unknown `kid`, a bad signature, a wrong issuer or audience, an
 * expired or not-yet-valid token, or a lifetime longer than an hour.
 */
export async function verifyAccessToken(
  keys: TokenKeys,
  token: string,
  expected: { issuer: string; audience: string; nowSeconds: number },
): Promise<AccessTokenClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown> | null;
  let payload: Record<string, unknown> | null;
  let signature: Uint8Array;
  try {
    header = parseJsonObject(base64urlDecode(h));
    payload = parseJsonObject(base64urlDecode(p));
    signature = base64urlDecode(s);
  } catch {
    return null;
  }
  if (!header || !payload || signature.length !== 64) return null;
  if (header.alg !== "EdDSA" || "crit" in header) return null;
  if (typeof header.kid !== "string") return null;
  const key = keys.verifyKeys.get(header.kid);
  if (!key) return null;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(ED25519, key, buf(signature), buf(utf8Encode(`${h}.${p}`)));
  } catch {
    return null;
  }
  if (!valid) return null;

  const { iss, aud, sub, sid, did, jti, auth_time, iat, exp } = payload;
  if (iss !== expected.issuer || aud !== expected.audience) return null;
  if (!isId(sub) || !isId(sid) || !isId(did) || !isId(jti)) return null;
  if (!isTime(auth_time) || !isTime(iat) || !isTime(exp)) return null;
  const now = expected.nowSeconds;
  if (exp <= now) return null; // expired
  if (iat > now + CLOCK_SKEW_SECONDS || auth_time > now + CLOCK_SKEW_SECONDS) return null;
  if (exp - iat > MAX_LIFETIME_SECONDS || exp <= iat) return null;
  return { iss, aud, sub, sid, did, auth_time, iat, exp, jti };
}
