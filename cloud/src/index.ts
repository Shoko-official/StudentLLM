// Cloudflare Worker entry. Builds the app from `createApp(deps)` once per isolate.

import { createApp, type App } from "./app";
import { ConfigError, loadConfig, type Env } from "./config";
import { consoleLogger, createDeps, defaultRequestId, systemClock } from "./deps";
import { errorResponse } from "./http/envelope";
import { createInMemoryStores } from "./storage";

const apps = new WeakMap<object, App | Response>();

function build(env: Env): App | "no_storage" {
  const config = loadConfig(env);
  // TODO(owner: ops): the Durable Object and D1 adapters are not written yet (docs in storage/interfaces.ts).
  // In-memory stores lose state on every isolate restart, so they may only back development.
  if (config.environment !== "development") return "no_storage";
  const deps = createDeps({
    config,
    clock: systemClock,
    stores: createInMemoryStores(),
    ids: { requestId: defaultRequestId },
    fetch: (input, init) => fetch(input, init),
    log: consoleLogger,
  });
  return createApp(deps);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let cached = apps.get(env);
    if (!cached) {
      try {
        const built = build(env);
        if (built === "no_storage") {
          console.error("storage adapters are not implemented; refusing to serve outside development");
          cached = errorResponse("internal_error", defaultRequestId());
        } else {
          cached = built;
        }
      } catch (error) {
        // Names of missing settings only, never values.
        console.error(error instanceof ConfigError ? error.message : "gateway failed to start");
        cached = errorResponse("internal_error", defaultRequestId());
      }
      apps.set(env, cached);
    }
    if (cached instanceof Response) {
      // Fail closed: a misconfigured deploy answers every request with a fresh internal_error envelope.
      return errorResponse("internal_error", defaultRequestId());
    }
    return cached.handle(request);
  },
};
