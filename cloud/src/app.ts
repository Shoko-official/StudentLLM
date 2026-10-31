import type { Deps } from "./deps";
import { createBodyReader } from "./http/body";
import type { RequestContext } from "./http/context";
import { ApiError, errorResponse, errorResponseFrom } from "./http/envelope";
import { buildPipeline, mergeHooks, type PipelineHooks } from "./http/pipeline";
import { Router } from "./http/router";
import { createAccountHooks, registerAccountRoutes } from "./modules/account";
import { createAuthHooks, registerAuthRoutes } from "./modules/auth";
import { createBillingHooks, registerBillingRoutes } from "./modules/billing";
import { createInferenceHooks, registerInferenceRoutes } from "./modules/inference";
import { createOpsHooks, registerOpsRoutes } from "./modules/ops";

export interface App {
  handle(request: Request): Promise<Response>;
  /** Exposed for tests and tooling (the route table). */
  readonly router: Router;
}

export interface AppOptions {
  /** Extra or replacement hooks, for tests. A hook already provided by a module is an error. */
  hooks?: Partial<PipelineHooks>;
}

/** Registers every module's routes. Add a module here only when a new module directory is created. */
export function registerRoutes(router: Router, deps: Deps): void {
  registerAuthRoutes(router, deps);
  registerAccountRoutes(router, deps);
  registerInferenceRoutes(router, deps);
  registerBillingRoutes(router, deps);
  registerOpsRoutes(router, deps);
}

function withRequestId(response: Response, requestId: string): Response {
  try {
    if (!response.headers.has("X-Request-Id")) response.headers.set("X-Request-Id", requestId);
    return response;
  } catch {
    // Immutable headers (a Response that came straight from fetch): copy it.
    const copy = new Response(response.body, response);
    copy.headers.set("X-Request-Id", requestId);
    return copy;
  }
}

export function createApp(deps: Deps, options: AppOptions = {}): App {
  const router = new Router();
  registerRoutes(router, deps);

  const hooks = mergeHooks(
    createAuthHooks(deps),
    createAccountHooks(deps),
    createInferenceHooks(deps),
    createBillingHooks(deps),
    createOpsHooks(deps),
    options.hooks ?? {},
  );
  const pipeline = buildPipeline(hooks);

  async function handle(request: Request): Promise<Response> {
    const started = deps.clock.now();
    const requestId = deps.ids.requestId();
    const deferred: Array<() => void | Promise<void>> = [];
    let ctx: RequestContext | undefined;
    let pattern = "unmatched";
    let response: Response;

    try {
      const url = new URL(request.url);
      const match = router.match(request.method.toUpperCase(), url.pathname);
      if (!match) {
        response = errorResponse("not_found", requestId);
      } else {
        pattern = match.route.pattern;
        const meta = match.route.meta;
        const maxBytes = meta.body.kind === "none" ? deps.config.limits.bodyBytes.small : deps.config.limits.bodyBytes[meta.body.limit];
        ctx = {
          request,
          url,
          requestId,
          pattern,
          meta,
          params: match.params,
          deps,
          body: createBodyReader(request, maxBytes),
          defer: (fn) => void deferred.push(fn),
        };
        response = (await pipeline(ctx)) ?? (await match.handler(ctx));
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        // Name and type only: error messages may carry request-derived text.
        console.error(`unhandled error in ${pattern}: ${error instanceof Error ? error.name : "unknown"}`);
      }
      response = errorResponseFrom(error, requestId);
    } finally {
      for (const fn of deferred.reverse()) {
        try {
          await fn();
        } catch {
          console.error(`deferred cleanup failed in ${pattern}`);
        }
      }
    }

    response = withRequestId(response, requestId);
    deps.log.request({
      requestId,
      accountId: ctx?.principal?.accountId ?? null,
      method: request.method.toUpperCase(),
      route: pattern,
      status: response.status,
      creditsCharged: ctx?.creditsCharged ?? null,
      latencyMs: Math.max(0, deps.clock.now() - started),
    });
    return response;
  }

  return { handle, router };
}
