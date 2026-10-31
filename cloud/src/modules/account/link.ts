// POST /v1/account/link and DELETE /v1/account/login-methods/{method}. Both need a fresh sign-in (`auth_time`
// within 5 minutes), which the built-in `freshAuthStep` enforces before these handlers run.
//
// Link: a single-use ticket, then the second method completes its own sign-in carrying it (see
// auth/email-routes.ts and auth/google-routes.ts). Unlink: never the last method.

import { randomToken } from "../../crypto/random";
import type { Deps } from "../../deps";
import { requirePrincipal, type Handler } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { LinkTicket } from "../../types";
import { tokenHash } from "../auth/codes";
import { LINK_TICKET_TTL_MS } from "../auth/constants";
import { parseShape } from "../auth/validate";

const LINK_SHAPE = { method: { kind: "string", oneOf: ["google", "email"] } } as const;

export function linkLoginMethodHandler(deps: Deps): Handler {
  return async (ctx) => {
    requirePrincipal(ctx);
    const body = parseShape(await ctx.body.json(), LINK_SHAPE);
    const account = ctx.account;
    if (!account) throw new Error("the account was not loaded");
    const method = body.method as "google" | "email";
    // Already linked: nothing to add.
    if (account.loginMethods.includes(method)) throw new ApiError("identity_conflict");
    const now = deps.clock.now();
    const ticket = randomToken("lt_");
    await deps.stores.authChallenges.putLinkTicket({
      ticketHash: await tokenHash(ticket),
      accountId: account.accountId,
      method,
      createdAt: now,
      expiresAt: now + LINK_TICKET_TTL_MS,
      used: false,
    });
    const result: LinkTicket = { link_ticket: ticket, expires_in: 300 };
    return jsonResponse(result, ctx.requestId);
  };
}

export function unlinkLoginMethodHandler(deps: Deps): Handler {
  return async (ctx) => {
    requirePrincipal(ctx);
    const method = ctx.params.method;
    if (method !== "google" && method !== "email") throw new ApiError("invalid_request", { message: "Unknown login method." });
    const account = ctx.account;
    if (!account) throw new Error("the account was not loaded");
    const removed = await deps.stores.accounts.removeLoginMethod(account.accountId, method);
    if (!removed.ok) {
      // Removing the last method, or a method the account does not have: both are a bad request.
      if (removed.reason === "not_found") throw new ApiError("session_revoked");
      throw new ApiError("invalid_request", {
        message: removed.reason === "last_method" ? "The last login method cannot be removed." : "That login method is not linked.",
      });
    }
    ctx.waitUntil(
      deps.auth.email.send({ kind: "login_method_unlinked", to: account.email, method }).catch(() => console.error("email send failed")),
    );
    return new Response(null, { status: 204 });
  };
}
