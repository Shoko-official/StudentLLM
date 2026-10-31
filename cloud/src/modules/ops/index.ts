// Ops module: service status and the minimum client version. OWNER: ops (shared). `GET /v1/status` is public, reads
// `X-StudentLLM-Client` (the version handshake runs in the pipeline) and sets `X-StudentLLM-Min-Client`. The Durable
// Object and D1 adapters, `wrangler.toml` and `src/durable-objects.ts` belong to this module too (they come later).

import type { CoreDeps, Deps } from "../../deps";
import { jsonResponse } from "../../http/envelope";
import { routeMeta, type Handler } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { featureAvailability } from "../inference/availability";
import { formatTime } from "../inference/time";

export interface OpsDeps {}

export function createOpsDeps(_core: CoreDeps): OpsDeps {
  return {};
}

export function createOpsHooks(_deps: Deps): Partial<PipelineHooks> {
  return {};
}

/** Cron work of this module (see src/scheduled.ts). */
export function createOpsScheduledTasks(_deps: Deps): ScheduledTask[] {
  return [];
}

/**
 * `maintenance` when the global kill switch is on, `degraded` when any switch is on, the global spend cap is reached
 * or a configured feature has nothing left that can serve it, otherwise `ok`. `features` says what can serve each
 * feature right now, so the app can fall back to local without trying.
 */
const getStatus: Handler = async (ctx) => {
  const { deps } = ctx;
  const now = deps.clock.now();
  const { features, degraded, maintenance } = await featureAvailability(deps, now);
  return jsonResponse(
    {
      status: maintenance ? "maintenance" : degraded ? "degraded" : "ok",
      min_client_version: deps.config.minClientVersion,
      features,
      server_time: formatTime(now),
    },
    ctx.requestId,
    { headers: { "X-StudentLLM-Min-Client": deps.config.minClientVersion } },
  );
};

export function registerOpsRoutes(router: Router, _deps: Deps): void {
  router.add("GET", "/v1/status", getStatus, routeMeta({ operationId: "getStatus", auth: "none", client: true }));
}
