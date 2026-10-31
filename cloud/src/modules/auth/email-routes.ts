// POST /auth/email/request and POST /auth/email/verify.

import { randomToken } from "../../crypto/random";
import type { Deps } from "../../deps";
import type { Handler, RequestContext } from "../../http/context";
import { ApiError, deviceLimitResponse, jsonResponse } from "../../http/envelope";
import type { PendingSignIn } from "../../storage";
import type { LinkResult } from "../../types";
import {
  canonicalCode,
  emailCodeHash,
  emailLookupHash,
  isPkceChallenge,
  newEmailCode,
  normalizeEmail,
  pkceChallenge,
  tokenHash,
} from "./codes";
import {
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_TTL_MS,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_REQUESTS_PER_ADDRESS_PER_HOUR,
  EMAIL_REQUESTS_PER_CONNECTION_PER_HOUR,
  EMAIL_RESEND_AFTER_SECONDS,
  FAILED_VERIFY_PER_ADDRESS_AND_CONNECTION_PER_HOUR,
  FAILED_VERIFY_PER_CONNECTION_PER_HOUR,
  HOUR_MS,
  MANAGE_TOKEN_TTL_MS,
} from "./constants";
import { connectionAddress, connectionKey, valueKey } from "./hooks";
import { completeSignIn } from "./signin";
import { BASE64URL_43_128, PKCE_VERIFIER, invalid, parseShape } from "./validate";

const REQUEST_SHAPE = {
  email: { kind: "string", min: 1, max: 254 },
  code_challenge: { kind: "string", pattern: BASE64URL_43_128 },
  code_challenge_method: { kind: "string", oneOf: ["S256"] },
  terms_version: { kind: "string", min: 1, max: 64 },
  device_label: { kind: "string", max: 64, optional: true },
  link_ticket: { kind: "string", min: 1, max: 256, optional: true },
} as const;

const VERIFY_SHAPE = {
  email: { kind: "string", min: 1, max: 254 },
  code: { kind: "string", pattern: new RegExp(`^[A-Za-z0-9]{${EMAIL_CODE_LENGTH}}$`) },
  code_verifier: { kind: "string", pattern: PKCE_VERIFIER },
  device_id: { kind: "string", min: 1, max: 128, optional: true },
  device_label: { kind: "string", max: 64, optional: true },
} as const;

/** `terms_required` with the current version, for a sign-in that did not carry it. */
export function termsRequired(deps: Deps): ApiError {
  return new ApiError("terms_required", { details: { terms_version: deps.config.termsVersion } });
}

function sendInBackground(ctx: RequestContext, deps: Deps, message: Parameters<Deps["auth"]["email"]["send"]>[0]): void {
  // A failing provider never fails the request; the fixed message carries no address or code.
  ctx.waitUntil(
    deps.auth.email.send(message).catch(() => {
      console.error("email send failed");
    }),
  );
}

export function emailRequestHandler(deps: Deps): Handler {
  return async (ctx) => {
    const body = parseShape(await ctx.body.json(), REQUEST_SHAPE);
    const { stores, config } = deps;
    if (body.terms_version !== config.termsVersion) throw termsRequired(deps);
    const email = normalizeEmail(body.email);
    if (email === null) throw invalid("The email address is not valid.");
    if (!isPkceChallenge(body.code_challenge)) throw invalid("Field \"code_challenge\" has an invalid format.");
    const now = deps.clock.now();
    const accepted = () =>
      jsonResponse({ expires_in: 600, resend_after: EMAIL_RESEND_AFTER_SECONDS, code_length: EMAIL_CODE_LENGTH }, ctx.requestId, { status: 202 });

    // A link flow: the ticket came from a signed-in session (POST /v1/account/link) and is spent at completion.
    let link: { ticketHash: string; accountId: string } | null = null;
    if (body.link_ticket !== undefined) {
      const ticketHash = await tokenHash(body.link_ticket);
      const ticket = await stores.authChallenges.getLinkTicket(ticketHash, now);
      if (!ticket || ticket.method !== "email") throw invalid("The link ticket is not valid.");
      link = { ticketHash, accountId: ticket.accountId };
    }

    // Limits first, keyed by hashes only. They apply whether or not the address is known.
    // A request inside the resend window of the address does NOTHING (the earlier code stays valid and nothing is
    // sent) and is answered exactly like any other, so a stranger cannot cancel a user's code by asking again, and
    // cannot tell from the answer whether a code was sent. (The user's app waits `resend_after` seconds.)
    const resend = await stores.rateLimits.hit(await valueKey(deps, "email-resend", email, now), 1, EMAIL_RESEND_AFTER_SECONDS * 1000, now);
    if (!resend.allowed) return accepted();
    const perAddress = await stores.rateLimits.hit(await valueKey(deps, "email-req", email, now), EMAIL_REQUESTS_PER_ADDRESS_PER_HOUR, HOUR_MS, now);
    if (!perAddress.allowed) throw new ApiError("rate_limited", { retryAfterSeconds: perAddress.retryAfterSeconds ?? 1 });
    const perConnection = await stores.rateLimits.hit(
      await connectionKey(deps, ctx.request, "conn-email-req", now),
      EMAIL_REQUESTS_PER_CONNECTION_PER_HOUR,
      HOUR_MS,
      now,
    );
    if (!perConnection.allowed) throw new ApiError("rate_limited", { retryAfterSeconds: perConnection.retryAfterSeconds ?? 1 });

    // Whether a code is really sent depends on the account, but the stored record and the answer do not:
    // an address that cannot sign in by email gets a pending record with a code nobody ever receives.
    const known = await stores.accounts.getByEmail(email);
    const deliverable = link !== null || !known || (known.loginMethods.includes("email") && known.status !== "deleting");
    const code = newEmailCode();
    const codeKey = config.secret("CODE_HMAC_KEY").reveal();
    await stores.authChallenges.replaceForEmail({
      id: randomToken("pi_", 16),
      kind: "email",
      stateHash: null,
      emailHash: await emailLookupHash(codeKey, email),
      codeChallenge: body.code_challenge,
      redirectType: null,
      redirectUri: null,
      appState: null,
      deviceLabel: body.device_label ?? null,
      termsVersion: body.terms_version,
      linkTicketId: link?.ticketHash ?? null,
      codeHash: await emailCodeHash(codeKey, email, code, body.code_challenge),
      accountId: link?.accountId ?? null,
      attempts: 0,
      resends: 0,
      createdAt: now,
      expiresAt: now + EMAIL_CODE_TTL_MS,
    });
    if (deliverable) sendInBackground(ctx, deps, { kind: "sign_in_code", to: email, code, purpose: link ? "link" : "sign_in" });

    return accepted();
  };
}

export function emailVerifyHandler(deps: Deps): Handler {
  return async (ctx) => {
    const body = parseShape(await ctx.body.json(), VERIFY_SHAPE);
    const { stores, config } = deps;
    const email = normalizeEmail(body.email);
    if (email === null) throw invalid("The email address is not valid.");
    const now = deps.clock.now();
    // The lockout is keyed by address AND connection: someone who only knows an address can lock out their own
    // connection, never the address owner's. (A separate cap per connection stops one connection from scanning
    // many addresses; the 5 attempts of one code and the 5 requests an hour per address bound the rest.)
    const failAddress = await valueKey(deps, "email-fail-pair", `${email}|${connectionAddress(ctx.request)}`, now);
    const failConnection = await connectionKey(deps, ctx.request, "conn-email-fail", now);
    if (
      (await stores.authChallenges.getCounter(failAddress, now)) >= FAILED_VERIFY_PER_ADDRESS_AND_CONNECTION_PER_HOUR ||
      (await stores.authChallenges.getCounter(failConnection, now)) >= FAILED_VERIFY_PER_CONNECTION_PER_HOUR
    ) {
      throw new ApiError("rate_limited", { retryAfterSeconds: 3600 });
    }
    const failed = async (): Promise<never> => {
      await stores.authChallenges.incrementCounter(failAddress, now, HOUR_MS);
      await stores.authChallenges.incrementCounter(failConnection, now, HOUR_MS);
      throw new ApiError("invalid_code");
    };

    // The code is bound to the PKCE challenge inside the hash, so the right code with the wrong verifier is a
    // wrong guess and counts as an attempt in the same atomic step. `consume: false`: the code is spent only
    // after the device slot was taken (see signin.ts).
    const codeKey = config.secret("CODE_HMAC_KEY").reveal();
    const checked = await stores.authChallenges.verifyEmailCode({
      emailHash: await emailLookupHash(codeKey, email),
      candidateCodeHash: await emailCodeHash(codeKey, email, canonicalCode(body.code), await pkceChallenge(body.code_verifier)),
      maxAttempts: EMAIL_MAX_ATTEMPTS,
      consume: false,
      now,
    });
    if (checked.outcome !== "ok") return failed();
    const pending = checked.pending;

    if (pending.linkTicketId !== null) return completeLink(ctx, deps, pending, email, failed);

    // Sign-in. The terms the user accepted when asking for the code must still be the current ones.
    if (pending.termsVersion !== config.termsVersion) throw termsRequired(deps);
    let account = await stores.accounts.getByEmail(email);
    if (!account) {
      const created = await stores.accounts.create({
        accountId: randomToken("acc_", 16),
        email,
        googleSubject: null,
        loginMethods: ["email"],
        termsVersion: pending.termsVersion,
        now,
      });
      account = created.ok ? created.account : await stores.accounts.getByEmail(email);
    }
    // Sign-in works only through a method the account still has; the answer is the generic one so it does not
    // reveal that the address exists.
    if (!account || !account.loginMethods.includes("email") || account.status === "deleting") return failed();
    if (account.termsVersion !== pending.termsVersion) {
      account = (await stores.accounts.acceptTerms(account.accountId, pending.termsVersion, now)) ?? account;
    }

    const result = await completeSignIn(deps, {
      account,
      pendingId: pending.id,
      deviceId: body.device_id,
      deviceLabel: body.device_label ?? pending.deviceLabel,
    });
    if (result.kind === "tokens") return jsonResponse(result.response, ctx.requestId);

    // At the device limit: the code check succeeded but the sign-in does not complete. The code stays unconsumed
    // and uncounted, and at most 3 manage tokens are minted for it.
    const manageToken = randomToken("mt_");
    const minted = await stores.devices.mintManageToken(
      { tokenHash: await tokenHash(manageToken), accountId: account.accountId, expiresAt: now + MANAGE_TOKEN_TTL_MS, codeId: pending.id },
      now,
    );
    if (!minted) throw new ApiError("device_limit_reached");
    return deviceLimitResponse(ctx.requestId, manageToken);
  };
}

async function completeLink(
  ctx: RequestContext,
  deps: Deps,
  pending: PendingSignIn,
  email: string,
  failed: () => Promise<never>,
): Promise<Response> {
  const { stores } = deps;
  const now = deps.clock.now();
  const account = pending.accountId ? await stores.accounts.getById(pending.accountId) : null;
  if (!account || account.status === "deleting") return failed();
  // One verified email per account: the second method must prove the account's own address.
  if (email !== account.email || account.loginMethods.includes("email")) throw new ApiError("identity_conflict");
  // Spend the code, then the ticket (both atomic and single use), then link.
  if (!(await stores.authChallenges.consume(pending.id, now))) return failed();
  if (!pending.linkTicketId || !(await stores.authChallenges.consumeLinkTicket(pending.linkTicketId, now))) return failed();
  const added = await stores.accounts.addLoginMethod(account.accountId, "email");
  if (!added.ok) throw new ApiError("identity_conflict");
  ctx.waitUntil(deps.auth.email.send({ kind: "login_method_linked", to: added.account.email, method: "email" }).catch(() => console.error("email send failed")));
  const result: LinkResult = { linked: true, method: "email", login_methods: added.account.loginMethods };
  return jsonResponse(result, ctx.requestId);
}
