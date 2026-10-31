// Cloudflare Worker entry. Builds the app from `createApp(deps)` once per isolate and forwards the
// ExecutionContext, so handlers can use `ctx.waitUntil` and `ctx.deferUntilBodyDone`.
//
// The export list of this module is settled on purpose: the default handlers (`fetch`, `scheduled`) and the
// Durable Object classes. Add a class here (and a wrangler migration) rather than from a module.

import { createApp, type App } from "./app";
import { ConfigError, loadConfig, type Env } from "./config";
import { consoleLogger, createDeps, defaultRequestId, systemClock } from "./deps";
import { errorResponse } from "./http/envelope";
import type { ExecutionContext, ScheduledController } from "./platform";
import { createInMemoryStores } from "./storage";

export { AccountObject } from "./durable-objects";

type Built = { app: App } | { failed: true };
const built = new WeakMap<object, Built>();

function build(env: Env): Built {
  try {
    const config = loadConfig(env);
    // TODO(owner: ops): the Durable Object and D1 adapters are not written yet (see storage/interfaces).
    // In-memory stores lose state on every isolate restart, so they may only back development.
    if (config.environment !== "development") {
      console.error("storage adapters are not implemented; refusing to serve outside development");
      return { failed: true };
    }
    const deps = createDeps({
      config,
      clock: systemClock,
      stores: createInMemoryStores(),
      ids: { requestId: defaultRequestId },
      fetch: (input, init) => fetch(input, init),
      log: consoleLogger,
    });
    return { app: createApp(deps) };
  } catch (error) {
    // Names of missing settings only, never values.
    console.error(error instanceof ConfigError ? error.message : "gateway failed to start");
    return { failed: true };
  }
}

function appFor(env: Env): App | undefined {
  let entry = built.get(env);
  if (!entry) {
    entry = build(env);
    built.set(env, entry);
  }
  return "app" in entry ? entry.app : undefined;
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const app = appFor(env);
    // Fail closed: a misconfigured deploy answers every request with a fresh internal_error envelope.
    if (!app) return errorResponse("internal_error", defaultRequestId());
    return app.handle(request, executionCtx);
  },

  async scheduled(controller: ScheduledController, env: Env, executionCtx: ExecutionContext): Promise<void> {
    const app = appFor(env);
    if (!app) return;
    await app.scheduled(controller, executionCtx);
  },
};
