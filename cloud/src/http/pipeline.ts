import type { RequestContext, Step } from "./context";

// The header-only check order of the content routes (docs/cloud-api.md, "Order of checks"):
//
//   1. client version        2. token and session   3. terms and account status
//   4. plan                  5. consent             6. rate-limit window
//
// These need only headers, so they run before the body is read. Then:
//
//   7. idempotency lookup    8. concurrency slot    (still before the body)
//   9. body validation while the body streams in (ctx.body: size limit, Content-Type)
//  10. budget reservation (inside the handler, after validation)
//
// Steps 1 and 9 are implemented here. The rest are hooks that the owning module fills in by returning
// them from its `create<Module>Hooks()`; until then they pass through. Steps are plain functions, so a
// module can compose its own (`composeSteps`).

import { clientVersionStep } from "./client-version";

/** Hooks other modules provide. Each is one step of the order above. */
export interface PipelineHooks {
  /** TODO(owner: auth): verify the access token / manage token and the session; set `ctx.principal`. Use `classifyBearer` and `assertTokenScope`. */
  authenticate: Step;
  /** TODO(owner: account): `terms_required` and `account_suspended` for gated routes; also enforce `meta.freshAuth` (`reauth_required`). */
  checkTermsAndStatus: Step;
  /** TODO(owner: billing): `plan_required` when `meta.requiresPlus`. */
  checkPlan: Step;
  /** TODO(owner: inference): validate `X-StudentLLM-Consent` against the active consent record (`consent_outdated`). */
  checkConsent: Step;
  /** TODO(owner: inference): the sliding window per account or per hashed connection (`rate_limited`). */
  checkRateLimit: Step;
  /** TODO(owner: inference): idempotency lookup (`idempotency_conflict`); a conflict never takes a concurrency slot. */
  lookupIdempotency: Step;
  /** TODO(owner: inference): take a concurrency slot (`concurrency_limit`); register the release with `ctx.defer`. */
  acquireConcurrencySlot: Step;
}

export type HookName = keyof PipelineHooks;

export const HOOK_ORDER: readonly HookName[] = [
  "authenticate",
  "checkTermsAndStatus",
  "checkPlan",
  "checkConsent",
  "checkRateLimit",
  "lookupIdempotency",
  "acquireConcurrencySlot",
];

const passThrough: Step = () => undefined;

export function defaultHooks(): PipelineHooks {
  return Object.fromEntries(HOOK_ORDER.map((name) => [name, passThrough])) as unknown as PipelineHooks;
}

/** Merges the hooks of several modules; two modules claiming the same hook is a wiring error. */
export function mergeHooks(...parts: Partial<PipelineHooks>[]): PipelineHooks {
  const merged: Partial<PipelineHooks> = {};
  for (const part of parts) {
    for (const name of Object.keys(part) as HookName[]) {
      if (merged[name]) throw new Error(`pipeline hook "${name}" is provided by two modules`);
      merged[name] = part[name]!;
    }
  }
  return { ...defaultHooks(), ...merged };
}

/** Runs steps in order; the first one that returns a Response stops the chain (a throw also stops it). */
export function composeSteps(...steps: Step[]): Step {
  return async (ctx: RequestContext) => {
    for (const step of steps) {
      const result = await step(ctx);
      if (result instanceof Response) return result;
    }
    return undefined;
  };
}

/** Applies a step only to routes where `applies` is true. */
function when(applies: (ctx: RequestContext) => boolean, step: Step): Step {
  return (ctx) => (applies(ctx) ? step(ctx) : undefined);
}

/** The full chain in contract order, up to (and not including) the handler. */
export function buildPipeline(hooks: PipelineHooks): Step {
  return composeSteps(
    when((c) => c.meta.client, clientVersionStep),
    when((c) => c.meta.auth !== "none", hooks.authenticate),
    when((c) => c.meta.auth !== "none" && c.meta.gate === "gated", hooks.checkTermsAndStatus),
    when((c) => c.meta.requiresPlus, hooks.checkPlan),
    when((c) => c.meta.content, hooks.checkConsent),
    when((c) => c.meta.rateLimit !== "none", hooks.checkRateLimit),
    when((c) => c.meta.content, hooks.lookupIdempotency),
    when((c) => c.meta.content, hooks.acquireConcurrencySlot),
  );
}
