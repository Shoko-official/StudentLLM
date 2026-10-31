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
// Built in here (real): the client-version handshake (1), the principal guard, the one-time account and plan
// load, the fresh sign-in check (`freshAuthStep`, right after authentication and independent of terms and
// suspension gating), the consent and idempotency header checks, and body handling (9).
//
// Hooks (the other steps) are filled in by the owning module through `create<Module>Hooks()`. A hook that no
// module provided FAILS CLOSED for any route with a real handler: it throws, which the app turns into 500
// `internal_error`, so a module that ships a handler before its hook cannot serve unauthenticated or
// unchecked traffic. Only the `notImplemented` stubs pass through. Tests that want pass-through hooks say so
// explicitly (`allowMissingHooks`).

import { ApiError } from "./envelope";
import { clientVersionStep } from "./client-version";
import type { RequestContext, RouteMeta, Step } from "./context";

/** Hooks other modules provide. Each is one step of the order above. */
export interface PipelineHooks {
  /**
   * TODO(owner: auth): verify the access token / manage token and the session and set `ctx.principal`. Use
   * `parseBearer`, `classifyBearer` and `assertTokenScope`. The account and plan are loaded afterwards by the
   * built-in `accountContextStep`; do not load them again.
   */
  authenticate: Step;
  /** TODO(owner: account): `terms_required` and `account_suspended` for gated routes (uses `ctx.account`). */
  checkTermsAndStatus: Step;
  /** TODO(owner: billing): `plan_required` when `meta.requiresPlus` (uses `ctx.plan`). */
  checkPlan: Step;
  /** TODO(owner: inference): check `ctx.consentId` against the active consent record (`consent_outdated`). */
  checkConsent: Step;
  /** TODO(owner: inference): the sliding window per account (`rateLimits.hit`), for `meta.rateLimit === "account"`. */
  checkRateLimit: Step;
  /** TODO(owner: auth): the per-connection window of unauthenticated routes, for `meta.rateLimit === "connection"`. */
  checkAuthRateLimit: Step;
  /** TODO(owner: inference): idempotency lookup with `ctx.idempotencyKey` (`idempotency_conflict`); a conflict never takes a slot. */
  lookupIdempotency: Step;
  /** TODO(owner: inference): take a concurrency slot (`concurrency_limit`); release it with `ctx.deferUntilBodyDone`. */
  acquireConcurrencySlot: Step;
}

export type HookName = keyof PipelineHooks;

export const HOOK_ORDER: readonly HookName[] = [
  "authenticate",
  "checkTermsAndStatus",
  "checkPlan",
  "checkConsent",
  "checkRateLimit",
  "checkAuthRateLimit",
  "lookupIdempotency",
  "acquireConcurrencySlot",
];

/** Which routes each hook applies to. Used to build the chain and to check at startup that nothing is missing. */
const HOOK_APPLIES: Record<HookName, (meta: RouteMeta) => boolean> = {
  authenticate: (m) => m.auth !== "none",
  checkTermsAndStatus: (m) => m.auth !== "none" && m.gate === "gated",
  checkPlan: (m) => m.requiresPlus,
  checkConsent: (m) => m.content,
  checkRateLimit: (m) => m.rateLimit === "account",
  checkAuthRateLimit: (m) => m.rateLimit === "connection",
  lookupIdempotency: (m) => m.content,
  acquireConcurrencySlot: (m) => m.content,
};

export function hooksNeededBy(meta: RouteMeta): HookName[] {
  return HOOK_ORDER.filter((name) => HOOK_APPLIES[name](meta));
}

const missingSteps = new WeakSet<Step>();

/** Default for a hook no module provided: passes only for `notImplemented` stubs, throws for real handlers. */
function failClosed(name: HookName): Step {
  const step: Step = (ctx) => {
    if (ctx.isStub) return;
    throw new Error(`pipeline hook "${name}" is not installed but ${ctx.meta.operationId} has a real handler`);
  };
  missingSteps.add(step);
  return step;
}

export function isMissingHook(step: Step): boolean {
  return missingSteps.has(step);
}

/** Hooks that fail closed for real handlers. This is what the app uses unless a module provides one. */
export function defaultHooks(): PipelineHooks {
  return Object.fromEntries(HOOK_ORDER.map((name) => [name, failClosed(name)])) as unknown as PipelineHooks;
}

/** Explicit opt-out for tests: every unprovided hook passes through. Never use it in the Worker entry. */
export function permissiveHooks(): PipelineHooks {
  const pass: Step = () => undefined;
  return Object.fromEntries(HOOK_ORDER.map((name) => [name, pass])) as unknown as PipelineHooks;
}

/** Merges the hooks of several modules; two modules claiming the same hook is a wiring error. */
export function mergeProvidedHooks(...parts: Partial<PipelineHooks>[]): Partial<PipelineHooks> {
  const merged: Partial<PipelineHooks> = {};
  for (const part of parts) {
    for (const name of Object.keys(part) as HookName[]) {
      if (merged[name]) throw new Error(`pipeline hook "${name}" is provided by two modules`);
      merged[name] = part[name]!;
    }
  }
  return merged;
}

/** As `mergeProvidedHooks`, filling every hook nobody provided with the fail-closed default. */
export function mergeHooks(...parts: Partial<PipelineHooks>[]): PipelineHooks {
  return { ...defaultHooks(), ...mergeProvidedHooks(...parts) };
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
function when(applies: (meta: RouteMeta) => boolean, step: Step): Step {
  return (ctx) => (applies(ctx.meta) ? step(ctx) : undefined);
}

// ---------------------------------------------------------------------------------------------------
// Built-in steps
// ---------------------------------------------------------------------------------------------------

/** Fails closed when an authenticated route got past `authenticate` without a principal. */
export const requirePrincipalStep: Step = (ctx) => {
  if (!ctx.principal && !ctx.isStub) throw new Error(`${ctx.meta.operationId} reached without a principal`);
};

/**
 * Loads the account and its plan ONCE per request after authentication (`ctx.account`, `ctx.plan`), records
 * activity at day granularity, and sets `X-StudentLLM-Plan-Version`. An account that no longer exists ends the
 * session (`session_revoked`: "account deleted").
 */
export const accountContextStep: Step = async (ctx) => {
  const principal = ctx.principal;
  if (!principal) return;
  const { accounts } = ctx.deps.stores;
  if (!ctx.account) {
    const account = await accounts.getById(principal.accountId);
    if (!account) throw new ApiError("session_revoked");
    ctx.account = account;
    ctx.plan = await accounts.getPlan(principal.accountId);
    await accounts.touchLastRequest(principal.accountId, ctx.deps.clock.now());
  }
  if (!ctx.responseHeaders.has("X-StudentLLM-Plan-Version")) {
    ctx.responseHeaders.set("X-StudentLLM-Plan-Version", String(ctx.account.planVersion));
  }
};

export const FRESH_AUTH_WINDOW_SECONDS = 300;

/**
 * Account export, linking, unlinking and deletion need `auth_time` within 5 minutes, otherwise
 * `reauth_required`. It runs right after authentication, before terms and suspension gating, so the check
 * can never be skipped by a route's gating exemption. A refresh copies `auth_time` unchanged, so a stolen
 * refresh token cannot refresh its way into one of these routes.
 */
export const freshAuthStep: Step = (ctx) => {
  if (!ctx.meta.freshAuth || !ctx.principal) return;
  if (ctx.principal.kind !== "access") throw new ApiError("insufficient_scope");
  const nowSeconds = Math.floor(ctx.deps.clock.now() / 1000);
  const age = nowSeconds - ctx.principal.authTime;
  // A time in the future (beyond a minute of clock skew) is as suspect as a stale one.
  if (!Number.isFinite(age) || age > FRESH_AUTH_WINDOW_SECONDS || age < -60) throw new ApiError("reauth_required");
};

const CONSENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A missing or invalid `X-StudentLLM-Consent` is `consent_outdated` (409). Sets `ctx.consentId`. */
export const consentHeaderStep: Step = (ctx) => {
  const value = ctx.request.headers.get("X-StudentLLM-Consent")?.trim() ?? "";
  if (!CONSENT_ID.test(value)) throw new ApiError("consent_outdated");
  ctx.consentId = value;
};

/** A missing or invalid `Idempotency-Key` (not a UUID) is `invalid_request` (400). Sets `ctx.idempotencyKey`. */
export const idempotencyKeyStep: Step = (ctx) => {
  const value = ctx.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!UUID.test(value)) throw new ApiError("invalid_request", { message: "Missing or invalid Idempotency-Key header." });
  ctx.idempotencyKey = value.toLowerCase();
};

/** The full chain in contract order, up to (and not including) the handler. */
export function buildPipeline(hooks: PipelineHooks): Step {
  const hook = (name: HookName): Step => when(HOOK_APPLIES[name], hooks[name]);
  return composeSteps(
    when((m) => m.client, clientVersionStep),
    hook("authenticate"),
    when((m) => m.auth !== "none", requirePrincipalStep),
    when((m) => m.auth !== "none", accountContextStep),
    when((m) => m.freshAuth, freshAuthStep),
    hook("checkTermsAndStatus"),
    hook("checkPlan"),
    when((m) => m.content, consentHeaderStep),
    hook("checkConsent"),
    hook("checkRateLimit"),
    hook("checkAuthRateLimit"),
    when((m) => m.content, idempotencyKeyStep),
    hook("lookupIdempotency"),
    hook("acquireConcurrencySlot"),
  );
}
