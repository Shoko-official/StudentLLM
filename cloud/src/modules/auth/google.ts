// Google sign-in, run by the gateway: the OpenID Connect authorization code flow with PKCE (S256), scopes
// `openid email` only and no offline access. The gateway verifies the ID token itself (signature against
// Google's JWKS, issuer, audience, expiry, nonce, `email_verified=true`) and then throws every Google token
// away: only the subject id and the verified email leave this file.
//
// All Google calls go through the injected `fetch` to FIXED https URLs (no client-supplied URL ever reaches
// them), with a timeout and without following redirects. Nothing from a Google response is logged.

import { base64urlDecode, utf8Decode, utf8Encode } from "../../crypto/encoding";
import { buf } from "./bytes";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleIdentity {
  /** Google's stable subject id. */
  subject: string;
  /** The verified email (`email_verified` was true). */
  email: string;
}

/** `access_denied`: Google refused or the token did not verify. `server_error`: Google could not be reached or answered oddly. */
export class GoogleSignInError extends Error {
  constructor(readonly reason: "access_denied" | "server_error") {
    super(reason);
    this.name = "GoogleSignInError";
  }
}

export interface GoogleClient {
  /** The URL to send the browser to (scope `openid email`, S256 PKCE, no offline access). */
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): Promise<string>;
  /** Exchanges the code, verifies the ID token and returns the identity. Every Google token is dropped here. */
  exchangeAndVerify(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string; nowSeconds: number }): Promise<GoogleIdentity>;
}

export interface GoogleClientOptions {
  fetch: typeof fetch;
  clientId: () => string;
  clientSecret: () => string;
  timeoutMs?: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MIN_MS = 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_RESPONSE_CHARS = 256 * 1024;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let jwks: { keys: Map<string, CryptoKey>; fetchedAt: number } | undefined;
  let pendingFetch: Promise<void> | undefined;

  async function call(url: string, init: RequestInit): Promise<Json> {
    let res: Response;
    try {
      res = await options.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new GoogleSignInError("server_error");
    }
    let parsed: unknown;
    try {
      const text = await res.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new Error("too large");
      parsed = JSON.parse(text);
    } catch {
      throw new GoogleSignInError("server_error");
    }
    const body = asObject(parsed);
    if (!res.ok) {
      // `invalid_grant` is a code that Google refused (used, expired, wrong verifier); anything else is on their side.
      throw new GoogleSignInError(res.status === 400 || res.status === 401 ? "access_denied" : "server_error");
    }
    if (!body) throw new GoogleSignInError("server_error");
    return body;
  }

  async function loadJwks(now: number): Promise<void> {
    const body = await call(GOOGLE_JWKS_ENDPOINT, { method: "GET", headers: { Accept: "application/json" } });
    const list = Array.isArray(body.keys) ? body.keys : [];
    const keys = new Map<string, CryptoKey>();
    for (const entry of list) {
      const jwk = asObject(entry);
      if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      try {
        keys.set(
          jwk.kid,
          await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
        );
      } catch {
        // A key we cannot import is skipped; the token then fails on an unknown kid.
      }
    }
    if (keys.size === 0) throw new GoogleSignInError("server_error");
    jwks = { keys, fetchedAt: now };
  }

  async function keyFor(kid: string, now: number): Promise<CryptoKey | undefined> {
    const fresh = jwks && now - jwks.fetchedAt < JWKS_TTL_MS;
    if (fresh && jwks!.keys.has(kid)) return jwks!.keys.get(kid);
    // Missing or stale: refetch, but not more than once a minute, and share one fetch between concurrent callers.
    if (!jwks || now - jwks.fetchedAt >= JWKS_REFETCH_MIN_MS) {
      pendingFetch ??= loadJwks(now).finally(() => {
        pendingFetch = undefined;
      });
      await pendingFetch;
    }
    return jwks?.keys.get(kid);
  }

  async function verifyIdToken(idToken: string, expected: { nonce: string; nowSeconds: number }): Promise<GoogleIdentity> {
    const denied = () => new GoogleSignInError("access_denied");
    if (idToken.length > 8192) throw denied();
    const parts = idToken.split(".");
    if (parts.length !== 3) throw denied();
    const [h, p, s] = parts as [string, string, string];
    let header: Json | null;
    let claims: Json | null;
    let signature: Uint8Array;
    try {
      header = asObject(JSON.parse(utf8Decode(base64urlDecode(h))));
      claims = asObject(JSON.parse(utf8Decode(base64urlDecode(p))));
      signature = base64urlDecode(s);
    } catch {
      throw denied();
    }
    if (!header || !claims) throw denied();
    // The algorithm is pinned: whatever the token says, only RS256 is verified (no `none`, no HMAC with the public key).
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw denied();
    const key = await keyFor(header.kid, expected.nowSeconds * 1000);
    if (!key) throw denied();
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, buf(signature), buf(utf8Encode(`${h}.${p}`)));
    } catch {
      throw denied();
    }
    if (!valid) throw denied();

    const clientId = options.clientId();
    if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) throw denied();
    const aud = claims.aud;
    const audienceOk = typeof aud === "string" ? aud === clientId : Array.isArray(aud) && aud.includes(clientId) && claims.azp === clientId;
    if (clientId === "" || !audienceOk) throw denied();
    const { exp, iat, nonce, sub, email } = claims;
    if (typeof exp !== "number" || exp <= expected.nowSeconds - CLOCK_SKEW_SECONDS) throw denied();
    if (typeof iat !== "number" || iat > expected.nowSeconds + CLOCK_SKEW_SECONDS) throw denied();
    if (typeof nonce !== "string" || nonce !== expected.nonce) throw denied();
    if (claims.email_verified !== true) throw denied();
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) throw denied();
    if (typeof email !== "string" || email.length === 0 || email.length > 254) throw denied();
    return { subject: sub, email };
  }

  return {
    async authorizationUrl(input) {
      const url = new URL(GOOGLE_AUTH_ENDPOINT);
      url.searchParams.set("client_id", options.clientId());
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "select_account");
      return url.toString();
    },

    async exchangeAndVerify(input) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: options.clientId(),
        client_secret: options.clientSecret(),
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      });
      const response = await call(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
      // Only the ID token is read. The access token and anything else Google returned are dropped with `response`.
      const idToken = response.id_token;
      if (typeof idToken !== "string") throw new GoogleSignInError("access_denied");
      return verifyIdToken(idToken, { nonce: input.nonce, nowSeconds: input.nowSeconds });
    },
  };
}

