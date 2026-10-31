// GET /auth/start, GET /auth/callback and POST /auth/token (the Google path).
//
//   app --(system browser)--> /auth/start --302--> Google --302--> /auth/callback --302--> app (loopback or deep link)
//   app --(Rust side)-------> POST /auth/token  (code + PKCE verifier) --> tokens, or a link result
//
// The gateway runs the OpenID Connect flow itself. The state, the nonce and the PKCE verifier of the gateway-to-Google
// leg are bound server-side: the state is stored (hashed) in the pending sign-in with a 10 minute TTL, and the nonce
// and the verifier are HMACs of that state under CODE_HMAC_KEY, so nothing about them has to be stored.

import { base64urlEncode } from "../../crypto/encoding";
import { hmacSha256Base64Url, sha256Base64Url, sha256Hex } from "../../crypto/hash";
import { randomBytes, randomToken } from "../../crypto/random";
import { constantTimeEqual } from "../../crypto/compare";
import type { Deps } from "../../deps";
import type { Handler } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { AccountRecord, PendingSignIn } from "../../storage";
import type { LinkResult } from "../../types";
import { googleAuthCodeHash, isPkceChallenge, normalizeEmail, pkceMatches, tokenHash } from "./codes";
import { CLIENT_ID, DEEP_LINK_REDIRECT_URI, GOOGLE_CODE_TTL_MS, GOOGLE_STATE_TTL_MS, LOOPBACK_REDIRECT_PATH } from "./constants";
import { termsRequired } from "./email-routes";
import { GoogleSignInError } from "./google";
import { completeSignIn } from "./signin";
import { BASE64URL_43_128, PKCE_VERIFIER, parseQuery, parseShape } from "./validate";

const START_SHAPE = {
  client_id: { kind: "string", oneOf: [CLIENT_ID] },
  redirect_uri: { kind: "string", min: 1, max: 512 },
  response_type: { kind: "string", oneOf: ["code"] },
  state: { kind: "string", pattern: /^[A-Za-z0-9._~-]{16,128}$/ },
  code_challenge: { kind: "string", pattern: BASE64URL_43_128 },
  code_challenge_method: { kind: "string", oneOf: ["S256"] },
  provider: { kind: "string", oneOf: ["google"] },
  terms_version: { kind: "string", min: 1, max: 64, optional: true },
  link_ticket: { kind: "string", min: 1, max: 256, optional: true },
} as const;

const TOKEN_SHAPE = {
  grant_type: { kind: "string", oneOf: ["authorization_code"] },
  code: { kind: "string", min: 16, max: 512 },
  code_verifier: { kind: "string", pattern: PKCE_VERIFIER },
  redirect_uri: { kind: "string", min: 1, max: 512 },
  client_id: { kind: "string", oneOf: [CLIENT_ID] },
  device_id: { kind: "string", min: 1, max: 128, optional: true },
  device_label: { kind: "string", max: 64, optional: true },
} as const;

type RedirectErrorCode = "access_denied" | "server_error" | "identity_conflict" | "terms_required";

/**
 * Loopback (RFC 8252): scheme `http`, host `127.0.0.1`, an explicit port (ignored when matching, so only its
 * presence and range are checked), the exact path, and nothing else. The deep link is matched exactly. Any other
 * URI is refused, because the gateway never redirects to an unverified address.
 */
export function classifyRedirectUri(uri: string): "loopback" | "deep_link" | null {
  if (uri === DEEP_LINK_REDIRECT_URI) return "deep_link";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.pathname !== LOOPBACK_REDIRECT_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  // `new URL` normalizes (default ports, case, dots); only accept what the client would have written.
  return url.toString() === uri ? "loopback" : null;
}

function redirect(location: string, requestId: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Request-Id": requestId },
  });
}

/** Redirect to the app with the app's own `state` and either a code or a bare error code, nothing more. */
function appRedirect(redirectUri: string, appState: string | null, params: Record<string, string>, requestId: string): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (appState !== null) url.searchParams.set("state", appState);
  return redirect(url.toString(), requestId);
}

const gatewayCallbackUrl = (deps: Deps) => new URL("/auth/callback", deps.config.issuer).toString();
const stateHash = (state: string) => sha256Hex(`google-state:${state}`);
const nonceFor = (codeKey: string, state: string) => hmacSha256Base64Url(codeKey, `google-nonce:${state}`);
const verifierFor = (codeKey: string, state: string) => hmacSha256Base64Url(codeKey, `google-pkce:${state}`);

export function authStartHandler(deps: Deps): Handler {
  return async (ctx) => {
    const q = parseQuery(ctx.url, START_SHAPE);
    const redirectType = classifyRedirectUri(q.redirect_uri);
    if (redirectType === null) throw new ApiError("invalid_request", { message: "The redirect address is not allowed." });
    if (!isPkceChallenge(q.code_challenge)) throw new ApiError("invalid_request");
    // Terms first (see docs/cloud-api.md): without the accepted current version nothing is created.
    if (q.terms_version !== deps.config.termsVersion) throw termsRequired(deps);
    if (deps.config.googleClientId === "") throw new Error("Google sign-in is not configured");
    const now = deps.clock.now();

    let link: { ticketHash: string; accountId: string } | null = null;
    if (q.link_ticket !== undefined) {
      const ticketHash = await tokenHash(q.link_ticket);
      const ticket = await deps.stores.authChallenges.getLinkTicket(ticketHash, now);
      if (!ticket || ticket.method !== "google") throw new ApiError("invalid_request", { message: "The link ticket is not valid." });
      link = { ticketHash, accountId: ticket.accountId };
    }

    const codeKey = deps.config.secret("CODE_HMAC_KEY").reveal();
    const googleState = base64urlEncode(randomBytes(32));
    await deps.stores.authChallenges.put({
      id: randomToken("pg_", 16),
      kind: "google",
      stateHash: await stateHash(googleState),
      emailHash: null,
      codeChallenge: q.code_challenge,
      redirectType,
      redirectUri: q.redirect_uri,
      appState: q.state,
      deviceLabel: null,
      termsVersion: q.terms_version,
      linkTicketId: link?.ticketHash ?? null,
      codeHash: null,
      accountId: link?.accountId ?? null,
      attempts: 0,
      resends: 0,
      createdAt: now,
      expiresAt: now + GOOGLE_STATE_TTL_MS,
    });
    const location = await deps.auth.google.authorizationUrl({
      state: googleState,
      nonce: await nonceFor(codeKey, googleState),
      codeChallenge: await sha256Base64Url(await verifierFor(codeKey, googleState)),
      redirectUri: gatewayCallbackUrl(deps),
    });
    return redirect(location, ctx.requestId);
  };
}

type Resolution =
  | { ok: true; account: AccountRecord; linked: boolean }
  | { ok: false; error: RedirectErrorCode };

/** Applies the identity rules to a verified Google identity. */
async function resolveIdentity(
  deps: Deps,
  pending: PendingSignIn,
  identity: { subject: string; email: string },
): Promise<Resolution> {
  const { accounts, authChallenges } = deps.stores;
  const now = deps.clock.now();
  const email = normalizeEmail(identity.email);
  if (email === null) return { ok: false, error: "access_denied" };
  const bySubject = await accounts.getByGoogleSubject(identity.subject);

  if (pending.linkTicketId !== null) {
    const account = pending.accountId ? await accounts.getById(pending.accountId) : null;
    if (!account || account.status === "deleting") return { ok: false, error: "access_denied" };
    // One verified email per account; and the Google identity must not already belong to any account.
    if (email !== account.email || account.loginMethods.includes("google") || bySubject) return { ok: false, error: "identity_conflict" };
    if (!(await authChallenges.consumeLinkTicket(pending.linkTicketId, now))) return { ok: false, error: "access_denied" };
    const added = await accounts.addLoginMethod(account.accountId, "google", identity.subject);
    if (!added.ok) return { ok: false, error: "identity_conflict" };
    return { ok: true, account: added.account, linked: true };
  }

  // Lookup by subject first, then by email. A known subject is that account even if Google's email changed
  // since (the stored email is not updated). A matching email alone never links or merges accounts.
  let account = bySubject;
  if (!account) {
    if (await accounts.getByEmail(email)) return { ok: false, error: "identity_conflict" };
    const created = await accounts.create({
      accountId: randomToken("acc_", 16),
      email,
      googleSubject: identity.subject,
      loginMethods: ["google"],
      termsVersion: pending.termsVersion,
      now,
    });
    if (!created.ok) return { ok: false, error: "identity_conflict" };
    account = created.account;
  }
  if (!account.loginMethods.includes("google")) return { ok: false, error: "identity_conflict" };
  if (account.status === "deleting") return { ok: false, error: "access_denied" };
  if (account.termsVersion !== pending.termsVersion) {
    account = (await accounts.acceptTerms(account.accountId, pending.termsVersion, now)) ?? account;
  }
  return { ok: true, account, linked: false };
}

export function authCallbackHandler(deps: Deps): Handler {
  return async (ctx) => {
    const state = ctx.url.searchParams.get("state");
    if (!state || state.length > 512) throw new ApiError("invalid_request", { message: "The sign-in state is missing." });
    const now = deps.clock.now();
    const { authChallenges } = deps.stores;
    // A state that matches nothing (wrong, replayed or expired) never redirects: the redirect address is only
    // trusted once the state proves this browser started the flow here.
    const found = await authChallenges.getByStateHash(await stateHash(state), now);
    const pending = found ? await authChallenges.consume(found.id, now) : null;
    if (!pending || pending.redirectUri === null) throw new ApiError("invalid_request", { message: "The sign-in state is not valid." });
    const back = (params: Record<string, string>) => appRedirect(pending.redirectUri!, pending.appState, params, ctx.requestId);
    const fail = (error: RedirectErrorCode) => back({ error });

    const code = ctx.url.searchParams.get("code");
    if (ctx.url.searchParams.has("error") || !code) return fail("access_denied");
    if (pending.termsVersion !== deps.config.termsVersion) return fail("terms_required");

    const codeKey = deps.config.secret("CODE_HMAC_KEY").reveal();
    let identity;
    try {
      identity = await deps.auth.google.exchangeAndVerify({
        code,
        codeVerifier: await verifierFor(codeKey, state),
        redirectUri: gatewayCallbackUrl(deps),
        nonce: await nonceFor(codeKey, state),
        nowSeconds: Math.floor(now / 1000),
      });
    } catch (error) {
      return fail(error instanceof GoogleSignInError ? error.reason : "server_error");
    }
    // `identity` is all that is kept of Google's answer; the tokens it came from are already gone.

    const resolved = await resolveIdentity(deps, pending, identity);
    if (!resolved.ok) return fail(resolved.error);

    const authCode = base64urlEncode(randomBytes(32));
    await authChallenges.put({
      ...pending,
      id: randomToken("pg_", 16),
      stateHash: null,
      codeHash: await googleAuthCodeHash(codeKey, authCode),
      accountId: resolved.account.accountId,
      createdAt: now,
      expiresAt: now + GOOGLE_CODE_TTL_MS,
    });
    if (resolved.linked) {
      ctx.waitUntil(
        deps.auth.email
          .send({ kind: "login_method_linked", to: resolved.account.email, method: "google" })
          .catch(() => console.error("email send failed")),
      );
    }
    return back({ code: authCode });
  };
}

export function authTokenHandler(deps: Deps): Handler {
  return async (ctx) => {
    const body = parseShape(await ctx.body.json(), TOKEN_SHAPE);
    const now = deps.clock.now();
    const { authChallenges, accounts } = deps.stores;
    const codeKey = deps.config.secret("CODE_HMAC_KEY").reveal();
    const pending = await authChallenges.getByCodeHash(await googleAuthCodeHash(codeKey, body.code), now);
    if (!pending || pending.kind !== "google" || pending.accountId === null || pending.redirectUri === null) throw new ApiError("invalid_code");

    // A wrong verifier or redirect address burns the code (OAuth security guidance): it cannot be tried again.
    const redirectOk = constantTimeEqual(pending.redirectUri, body.redirect_uri);
    const verifierOk = await pkceMatches(body.code_verifier, pending.codeChallenge);
    if (!redirectOk || !verifierOk) {
      await authChallenges.consume(pending.id, now);
      throw new ApiError("invalid_code");
    }

    const account = await accounts.getById(pending.accountId);
    if (!account || account.status === "deleting") throw new ApiError("invalid_code");

    if (pending.linkTicketId !== null) {
      // The link was made at the callback; completion returns success, not a session.
      if (!(await authChallenges.consume(pending.id, now))) throw new ApiError("invalid_code");
      const result: LinkResult = { linked: true, method: "google", login_methods: account.loginMethods };
      return jsonResponse(result, ctx.requestId);
    }

    const result = await completeSignIn(deps, { account, pendingId: pending.id, deviceId: body.device_id, deviceLabel: body.device_label });
    // The Google path never issues a manage token.
    if (result.kind === "device_limit") throw new ApiError("device_limit_reached");
    return jsonResponse(result.response, ctx.requestId);
  };
}

