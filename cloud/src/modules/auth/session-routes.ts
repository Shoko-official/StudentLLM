// POST /auth/refresh, POST /auth/logout and GET /.well-known/jwks.json.

import type { Deps } from "../../deps";
import type { Handler } from "../../http/context";
import { jsonResponse } from "../../http/envelope";
import { refreshSession, logoutSession } from "./sessions";
import { parseShape } from "./validate";

const REFRESH_SHAPE = {
  refresh_token: { kind: "string", min: 1, max: 512 },
  device_id: { kind: "string", min: 1, max: 128 },
} as const;

const LOGOUT_SHAPE = { refresh_token: { kind: "string", min: 1, max: 512 } } as const;

export function refreshHandler(deps: Deps): Handler {
  return async (ctx) => {
    const body = parseShape(await ctx.body.json(), REFRESH_SHAPE);
    const tokens = await refreshSession(deps, { refreshToken: body.refresh_token, deviceId: body.device_id });
    return jsonResponse(tokens, ctx.requestId);
  };
}

export function logoutHandler(deps: Deps): Handler {
  return async (ctx) => {
    const body = parseShape(await ctx.body.json(), LOGOUT_SHAPE);
    await logoutSession(deps, body.refresh_token);
    return new Response(null, { status: 204 });
  };
}

export function jwksHandler(deps: Deps): Handler {
  return async (ctx) => {
    const keys = await deps.auth.keys();
    const response = jsonResponse(keys.jwks, ctx.requestId);
    response.headers.set("Cache-Control", "public, max-age=300");
    return response;
  };
}
