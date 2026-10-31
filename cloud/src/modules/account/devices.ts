// GET /v1/devices and DELETE /v1/devices/{device_id}. Both accept an access token or the opaque manage token
// (the only two routes that do). Revocation takes effect on the very next request: the session family is revoked
// and the device is removed, and `authenticate` checks both.

import type { Deps } from "../../deps";
import { requirePrincipal, type Handler } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { DeviceList } from "../../types";
import { pruneDevicesWithoutSession } from "../auth/signin";
import { toIso } from "../auth/plan";

export function listDevicesHandler(deps: Deps): Handler {
  return async (ctx) => {
    const principal = requirePrincipal(ctx);
    // Devices whose sessions are all gone do not count; this is also where an expired session frees its slot.
    await pruneDevicesWithoutSession(deps, principal.accountId);
    const devices = await deps.stores.devices.list(principal.accountId);
    const body: DeviceList = {
      devices: devices
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((d) => ({
          device_id: d.deviceId,
          label: d.label,
          created_at: toIso(d.createdAt),
          last_used_at: toIso(d.lastUsedAt),
          // Under a manage token no device is "current".
          current: principal.kind === "access" && principal.deviceId === d.deviceId,
        })),
    };
    return jsonResponse(body, ctx.requestId);
  };
}

export function revokeDeviceHandler(deps: Deps): Handler {
  return async (ctx) => {
    const principal = requirePrincipal(ctx);
    const deviceId = ctx.params.device_id;
    if (!deviceId) throw new ApiError("not_found");
    const { devices, sessions } = deps.stores;
    // Only a device of the authenticated account can be touched: another account's id is just "not found".
    const device = await devices.get(principal.accountId, deviceId);
    if (!device) throw new ApiError("not_found");
    const now = deps.clock.now();
    await sessions.revokeByDevice(principal.accountId, deviceId, now);
    await devices.revoke(principal.accountId, deviceId);
    if (principal.kind === "manage" && ctx.account) {
      ctx.waitUntil(
        deps.auth.email
          .send({ kind: "device_revoked", to: ctx.account.email, deviceLabel: device.label })
          .catch(() => console.error("email send failed")),
      );
    }
    return new Response(null, { status: 204 });
  };
}
