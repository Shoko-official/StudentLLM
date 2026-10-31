// Test-only: the app wired with the auth and account modules for real, a fake Google, a fake email sender,
// in-memory stores, a manual clock and a generated signing key. Helpers drive the sign-in flows over HTTP so
// tests exercise the same path a client would.

import { base64urlEncode } from "../crypto/encoding";
import { sha256Base64Url } from "../crypto/hash";
import { randomBytes } from "../crypto/random";
import { loadConfig, type Env } from "../config";
import { silentLogger, type CoreDeps } from "../deps";
import { createAccountDeps } from "../modules/account";
import type { AccountDeps } from "../modules/account/deps";
import { createAuthDeps } from "../modules/auth";
import type { AuthDeps } from "../modules/auth/deps";
import { createInMemoryStores, type Stores } from "../storage";
import type { TokenResponse } from "../types";
import { FakeEmailSender } from "./fake-email";
import { FakeGoogle } from "./fake-google";
import { makeTestApp, ManualClock, testEnv, type TestApp, type TestAppOptions } from "./test-app";

export const CLIENT = "studentllm-desktop/0.2.0";

export async function generateSigningKeyPkcs8(): Promise<{ pkcs8: string; publicX: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pkcs8: btoa(String.fromCharCode(...pkcs8)), publicX: jwk.x! };
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64urlEncode(randomBytes(32));
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export interface AuthHarness extends TestApp {
  email: FakeEmailSender;
  google: FakeGoogle;
  env: Env;
  /** The generated signing key of this app (PKCS8 base64) and its public half (base64url `x`). */
  signing: { pkcs8: string; publicX: string };
  /** Core services shared with the module deps (for building extra deps in a test). */
  core: CoreDeps;
  /** JSON request helper: sends `body` as JSON, returns the response. */
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  del(path: string, headers?: Record<string, string>): Promise<Response>;
  /** Email sign-in end to end; returns the verify response (tokens, a device-limit response, or an error). */
  emailSignIn(email: string, options?: { deviceId?: string; deviceLabel?: string; terms?: string }): Promise<Response>;
  /** Same, asserting success, returning the tokens. */
  signedIn(email: string, options?: { deviceId?: string; deviceLabel?: string }): Promise<TokenResponse>;
  /** Sign-in with Google over the real redirects; returns the final /auth/token response. */
  googleSignIn(identity: { sub: string; email: string; email_verified?: boolean }, options?: { deviceId?: string; deviceLabel?: string }): Promise<Response>;
}

export interface AuthHarnessOptions extends Omit<TestAppOptions, "deps" | "fetch"> {
  authDeps?: Partial<AuthDeps>;
  accountDeps?: Partial<AccountDeps>;
}

export async function makeAuthApp(options: AuthHarnessOptions = {}): Promise<AuthHarness> {
  const clock = options.clock ?? new ManualClock();
  const stores: Stores = options.stores ?? createInMemoryStores();
  const email = new FakeEmailSender();
  const google = await FakeGoogle.create(() => clock.now());
  const signing = await generateSigningKeyPkcs8();
  const env = testEnv({ TOKEN_SIGNING_KEY: signing.pkcs8, GOOGLE_CLIENT_ID: google.clientId, ...options.env });
  const config = options.config ?? loadConfig(env);
  const core: CoreDeps = { config, clock, stores, ids: { requestId: () => "req_unused" }, fetch: google.fetch, log: silentLogger };
  const t = makeTestApp({
    ...options,
    config,
    clock,
    stores,
    fetch: google.fetch,
    allowMissingHooks: options.allowMissingHooks ?? true,
    deps: {
      auth: createAuthDeps(core, { email, ...options.authDeps }),
      account: createAccountDeps(core, options.accountDeps),
    },
  });

  const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const h: AuthHarness = {
    ...t,
    email,
    google,
    env,
    signing,
    core,
    post: (path, body, headers) => t.request(path, json(body, headers)),
    get: (path, headers) => t.request(path, { headers }),
    del: (path, headers) => t.request(path, { method: "DELETE", headers }),
    async emailSignIn(address, opts = {}) {
      // Stay clear of the 60-second minimum between two code requests for one address.
      t.clock.advance(61_000);
      const pkce = await pkcePair();
      const requested = await h.post("/auth/email/request", {
        email: address,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        terms_version: opts.terms ?? config.termsVersion,
        ...(opts.deviceLabel ? { device_label: opts.deviceLabel } : {}),
      });
      if (requested.status !== 202) return requested;
      const code = email.lastCode(address.trim().toLowerCase());
      if (!code) throw new Error("no code was sent");
      return h.post("/auth/email/verify", {
        email: address,
        code,
        code_verifier: pkce.verifier,
        ...(opts.deviceId ? { device_id: opts.deviceId } : {}),
      });
    },
    async signedIn(address, opts) {
      const res = await h.emailSignIn(address, opts);
      if (res.status !== 200) throw new Error(`sign-in failed with ${res.status}: ${await res.text()}`);
      return (await res.json()) as TokenResponse;
    },
    async googleSignIn(identity, opts = {}) {
      const pkce = await pkcePair();
      const appState = base64urlEncode(randomBytes(16));
      const redirectUri = "http://127.0.0.1:50321/callback";
      const start = await h.get(
        `/auth/start?${new URLSearchParams({
          client_id: "studentllm-desktop",
          redirect_uri: redirectUri,
          response_type: "code",
          state: appState,
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          provider: "google",
          terms_version: config.termsVersion,
        })}`,
      );
      if (start.status !== 302) return start;
      const granted = google.authorize(start.headers.get("Location")!, identity);
      const callback = await h.get(`/auth/callback?${granted.query}`);
      const back = new URL(callback.headers.get("Location")!);
      const code = back.searchParams.get("code");
      if (!code) return callback;
      if (back.searchParams.get("state") !== appState) throw new Error("the app state was not echoed back");
      return h.post("/auth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        redirect_uri: redirectUri,
        client_id: "studentllm-desktop",
        ...(opts.deviceId ? { device_id: opts.deviceId } : {}),
        ...(opts.deviceLabel ? { device_label: opts.deviceLabel } : {}),
      });
    },
  };
  return h;
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
