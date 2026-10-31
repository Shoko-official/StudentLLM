// Test-only: a fake Google. It plays both sides the gateway talks to (the token endpoint and the JWKS) through an
// injected `fetch`, signs ID tokens with its own RSA key, and checks what the gateway sends (client id and
// secret present, the exact redirect URI, PKCE S256). No network.

import { base64urlEncode, utf8Encode } from "../crypto/encoding";
import { sha256Base64Url } from "../crypto/hash";
import { buf } from "../modules/auth/bytes";
import { GOOGLE_JWKS_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../modules/auth/google";

export interface FakeIdentity {
  sub: string;
  email: string;
  email_verified?: boolean;
}

export interface TokenOverrides {
  /** Merged over the claims (use `undefined` values to drop a claim). */
  claims?: Record<string, unknown>;
  /** Merged over the JOSE header. */
  header?: Record<string, unknown>;
  /** Sign with this key instead of Google's (a forged signature). */
  signWith?: CryptoKey;
  /** Use this exact token instead of building one. */
  rawToken?: string;
}

interface Grant {
  identity: FakeIdentity;
  nonce: string;
  redirectUri: string;
  codeChallenge: string;
  clientId: string;
  overrides: TokenOverrides;
  used: boolean;
}

export class FakeGoogle {
  readonly clientId = "test-google-client-id";
  readonly calls: Array<{ url: string; method: string }> = [];
  /** Make the next token or JWKS call fail like an outage. */
  outage = false;
  private grants = new Map<string, Grant>();
  private counter = 0;

  private constructor(
    readonly keys: CryptoKeyPair,
    readonly publicJwk: JsonWebKey,
    readonly kid: string,
    private readonly now: () => number,
  ) {}

  static async create(now: () => number, kid = "google-key-1"): Promise<FakeGoogle> {
    const keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return new FakeGoogle(keys, await crypto.subtle.exportKey("jwk", keys.publicKey), kid, now);
  }

  /** Another RSA key pair, to forge tokens with. */
  static async forgeryKey(): Promise<CryptoKey> {
    const keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return keys.privateKey;
  }

  /**
   * The user approves in the browser: takes the URL the gateway redirected to (`Location` of /auth/start) and
   * returns what Google would put on the redirect back to the gateway.
   */
  authorize(location: string, identity: FakeIdentity, overrides: TokenOverrides = {}): { code: string; state: string; query: string } {
    const url = new URL(location);
    if (url.origin + url.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error("not a Google authorization URL");
    const p = url.searchParams;
    if (p.get("scope") !== "openid email") throw new Error(`unexpected scope ${p.get("scope")}`);
    if (p.get("response_type") !== "code") throw new Error("response_type must be code");
    if (p.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 is required");
    if (p.has("access_type")) throw new Error("no offline access");
    const code = `fake-google-code-${++this.counter}`;
    this.grants.set(code, {
      identity,
      nonce: p.get("nonce") ?? "",
      redirectUri: p.get("redirect_uri") ?? "",
      codeChallenge: p.get("code_challenge") ?? "",
      clientId: p.get("client_id") ?? "",
      overrides,
      used: false,
    });
    const state = p.get("state") ?? "";
    return { code, state, query: `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` };
  }

  private async idToken(grant: Grant): Promise<string> {
    if (grant.overrides.rawToken !== undefined) return grant.overrides.rawToken;
    const nowSeconds = Math.floor(this.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: "https://accounts.google.com",
      aud: this.clientId,
      azp: this.clientId,
      sub: grant.identity.sub,
      email: grant.identity.email,
      email_verified: grant.identity.email_verified ?? true,
      nonce: grant.nonce,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      ...grant.overrides.claims,
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    const header = { alg: "RS256", kid: this.kid, typ: "JWT", ...grant.overrides.header };
    const signingInput = `${base64urlEncode(utf8Encode(JSON.stringify(header)))}.${base64urlEncode(utf8Encode(JSON.stringify(claims)))}`;
    if (header.alg === "none") return `${signingInput}.`;
    const key = grant.overrides.signWith ?? this.keys.privateKey;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, buf(utf8Encode(signingInput))));
    return `${signingInput}.${base64urlEncode(sig)}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    this.calls.push({ url, method });
    if (init?.redirect !== "error") throw new Error("the gateway must not follow redirects from Google");
    if (this.outage) throw new TypeError("fake network failure");
    if (url === GOOGLE_JWKS_ENDPOINT && method === "GET") {
      return Response.json({ keys: [{ ...this.publicJwk, kid: this.kid, alg: "RS256", use: "sig", key_ops: undefined, ext: undefined }] });
    }
    if (url === GOOGLE_TOKEN_ENDPOINT && method === "POST") {
      const form = new URLSearchParams(String(init?.body));
      const grant = this.grants.get(form.get("code") ?? "");
      const bad = () => Response.json({ error: "invalid_grant" }, { status: 400 });
      if (!grant || grant.used || form.get("grant_type") !== "authorization_code") return bad();
      grant.used = true;
      if (form.get("client_id") !== this.clientId || !form.get("client_secret")) return bad();
      if (form.get("redirect_uri") !== grant.redirectUri) return bad();
      const verifier = form.get("code_verifier") ?? "";
      if ((await sha256Base64Url(verifier)) !== grant.codeChallenge) return bad();
      return Response.json({
        access_token: "fake-google-access-token",
        id_token: await this.idToken(grant),
        expires_in: 3599,
        token_type: "Bearer",
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
      });
    }
    throw new Error(`unexpected network call to ${method} ${url}`);
  };
}
