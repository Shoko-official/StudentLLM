// Ops module: service status and minimum client version, later kill switches and the reconciler schedule.
// OWNER: ops (shared). `GET /v1/status` sets `X-StudentLLM-Min-Client` on success.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { notImplemented } from "../../http/stub";

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

export function registerOpsRoutes(router: Router, _deps: Deps): void {
  router.add("GET", "/v1/status", notImplemented, routeMeta({ operationId: "getStatus", auth: "none", client: true }));
}
