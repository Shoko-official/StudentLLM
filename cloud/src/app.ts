import type { Deps } from "./deps";
import { createBodyReader } from "./http/body";
import type { Handler, RequestContext } from "./http/context";
import { ApiError, errorResponse, errorResponseFrom } from "./http/envelope";
import {
  buildPipeline,
  defaultHooks,
  hooksNeededBy,
  isMissingHook,
  mergeProvidedHooks,
  permissiveHooks,
  type PipelineHooks,
} from "./http/pipeline";
import { Router } from "./http/router";
import { createAccountHooks, createAccountScheduledTasks, registerAccountRoutes } from "./modules/account";
import { createAuthHooks, createAuthScheduledTasks, registerAuthRoutes } from "./modules/auth";
import { createBillingHooks, createBillingScheduledTasks, registerBillingRoutes } from "./modules/billing";
import { createInferenceHooks, createInferenceScheduledTasks, registerInferenceRoutes } from "./modules/inference";
import { createOpsHooks, createOpsScheduledTasks, registerOpsRoutes } from "./modules/ops";
import type { ExecutionContext, ScheduledController } from "./platform";
import type { ScheduledTask } from "./scheduled";

export interface App {
  /** `executionCtx` is the Worker's `ExecutionContext`; it backs `ctx.waitUntil`. */
  handle(request: Request, executionCtx?: ExecutionContext): Promise<Response>;
  /** The Worker's cron entry: runs every module's scheduled tasks. */
  scheduled(controller: ScheduledController, executionCtx?: ExecutionContext): Promise<void>;
  /** Exposed for tests and tooling (the route table). */
  readonly router: Router;
}

export interface AppOptions {
  /** Hooks that override whatever the modules provide (tests). They win over module hooks. */
  hooks?: Partial<PipelineHooks>;
  /**
   * Explicit opt-out of fail-closed hooks: every hook nobody provided passes through. For tests only; the
   * Worker entry never sets it.
   */
  allowMissingHooks?: boolean;
  /**
   * Ignores the pipeline hooks the modules provide, so a pipeline test can install its own or none (tests only; the
   * Worker entry never sets it).
   */
  withoutModuleHooks?: boolean;
  /** Replaces `registerRoutes` (tests that register their own routes). */
  registerRoutes?: (router: Router, deps: Deps) => void;
}

/** Registers every module's routes. Add a module here only when a new module directory is created. */
export function registerRoutes(router: Router, deps: Deps): void {
  registerAuthRoutes(router, deps);
  registerAccountRoutes(router, deps);
  registerInferenceRoutes(router, deps);
  registerBillingRoutes(router, deps);
  registerOpsRoutes(router, deps);
}

/**
 * Adds X-Request-Id (when absent) and the headers collected in `ctx.responseHeaders` (when the handler did
 * not set them itself). Headers of a Response may be immutable (one that came straight from fetch): copy it then.
 */
function decorate(response: Response, requestId: string, extra: Headers): Response {
  const apply = (r: Response): void => {
    if (!r.headers.has("X-Request-Id")) r.headers.set("X-Request-Id", requestId);
    extra.forEach((value, name) => {
      if (!r.headers.has(name)) r.headers.set(name, value);
    });
  };
  try {
    apply(response);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    apply(copy);
    return copy;
  }
}

/**
 * Runs `cleanups` once after the body was fully read or cancelled. With no body they run at once. The
 * cleanup runs BEFORE the stream reports its end, so a consumer that saw the end can rely on it having run.
 */
async function afterBody(response: Response, run: () => Promise<void>, executionCtx?: ExecutionContext): Promise<Response> {
  if (!response.body) {
    await run();
    return response;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await run();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        await run();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        // A client that disconnects may let the runtime drop this promise: waitUntil keeps the Worker alive
        // until the cleanup (for example releasing a concurrency slot) has finished.
        const cleanup = run();
        executionCtx?.waitUntil(cleanup.catch(() => undefined));
        await cleanup;
      }
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => (started ??= fn());
}

/**
 * Module hooks first, then the explicit overrides: `{ ...defaults, ...modules, ...overrides }`, so a test's
 * hook always wins over a module's. Two modules claiming one hook is an error, whatever the overrides.
 */
export function composeHooks(
  moduleHooks: Partial<PipelineHooks>[],
  overrides: Partial<PipelineHooks> | undefined,
  allowMissingHooks: boolean | undefined,
): PipelineHooks {
  return {
    ...(allowMissingHooks ? permissiveHooks() : defaultHooks()),
    ...mergeProvidedHooks(...moduleHooks),
    ...overrides,
  };
}

export function createApp(deps: Deps, options: AppOptions = {}): App {
  const router = new Router();
  (options.registerRoutes ?? registerRoutes)(router, deps);

  const hooks = composeHooks(
    options.withoutModuleHooks
      ? []
      : [createAuthHooks(deps), createAccountHooks(deps), createInferenceHooks(deps), createBillingHooks(deps), createOpsHooks(deps)],
    options.hooks,
    options.allowMissingHooks,
  );

  // Strict startup check: a real handler whose hook nobody provided is a wiring error, not a runtime surprise.
  if (!options.allowMissingHooks) {
    const problems: string[] = [];
    for (const route of router.routes()) {
      if (route.isStub) continue;
      for (const name of hooksNeededBy(route.meta)) {
        if (isMissingHook(hooks[name])) problems.push(`${route.method} ${route.pattern} needs hook "${name}"`);
      }
    }
    if (problems.length > 0) throw new Error(`pipeline hooks are missing:\n- ${problems.join("\n- ")}`);
  }

  const pipeline = buildPipeline(hooks);
  const scheduledTasks: ScheduledTask[] = [
    ...createAuthScheduledTasks(deps),
    ...createAccountScheduledTasks(deps),
    ...createInferenceScheduledTasks(deps),
    ...createBillingScheduledTasks(deps),
    ...createOpsScheduledTasks(deps),
  ];

  async function handle(request: Request, executionCtx?: ExecutionContext): Promise<Response> {
    const started = deps.clock.now();
    const requestId = deps.ids.requestId();
    const deferred: Array<() => void | Promise<void>> = [];
    const afterBodyFns: Array<() => void | Promise<void>> = [];
    let ctx: RequestContext | undefined;
    let pattern = "unmatched";
    let response: Response;

    const runAll = async (fns: Array<() => void | Promise<void>>, label: string) => {
      for (const fn of [...fns].reverse()) {
        try {
          await fn();
        } catch {
          // Name only: a cleanup error message could carry request-derived text.
          console.error(`${label} cleanup failed in ${pattern}`);
        }
      }
    };

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
          // Handlers get the request without its body; the body is only reachable through ctx.body.
          request: new Request(request.url, { method: request.method, headers: request.headers }),
          url,
          requestId,
          pattern,
          meta,
          params: match.params,
          deps,
          body: createBodyReader(request, maxBytes),
          isStub: match.route.isStub,
          locals: {},
          responseHeaders: new Headers(),
          defer: (fn) => void deferred.push(fn),
          deferUntilBodyDone: (fn) => void afterBodyFns.push(fn),
          waitUntil: (promise) => executionCtx?.waitUntil(promise.catch(() => console.error(`background task failed in ${pattern}`))),
        };
        response = (await pipeline(ctx)) ?? (await (match.handler as Handler)(ctx));
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        // Name and type only: error messages may carry request-derived text.
        console.error(`unhandled error in ${pattern}: ${error instanceof Error ? error.name : "unknown"}`);
      }
      response = errorResponseFrom(error, requestId);
    } finally {
      await runAll(deferred, "deferred");
    }

    response = decorate(response, requestId, ctx?.responseHeaders ?? new Headers());
    if (afterBodyFns.length > 0) response = await afterBody(response, once(() => runAll(afterBodyFns, "after-body")), executionCtx);

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

  async function scheduled(controller: ScheduledController, executionCtx?: ExecutionContext): Promise<void> {
    const work = Promise.all(
      scheduledTasks.map(async (task) => {
        try {
          await task.run(controller);
        } catch {
          console.error(`scheduled task ${task.name} failed`);
        }
      }),
    ).then(() => undefined);
    executionCtx?.waitUntil(work);
    await work;
  }

  return { handle, scheduled, router };
}
