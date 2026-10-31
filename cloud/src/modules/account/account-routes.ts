// GET /v1/account, DELETE /v1/account, GET /v1/account/export, POST /v1/account/terms.
// All four are exempt from the terms and suspension gating: data-rights routes always work.

import type { Deps } from "../../deps";
import { requirePrincipal, type Handler, type RequestContext } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { ConsentRow, PlanRecord } from "../../storage";
import type { Account, AccountExport, ConsentRecord, Credits, DeletionResponse, TermsAcceptance } from "../../types";
import { planObject, toIso } from "../auth/plan";
import { parseShape } from "../auth/validate";
import { attemptDeletion, deletionId } from "./deletion";
import { inferenceSeam } from "./seams";

export function consentRecord(row: ConsentRow): ConsentRecord {
  return {
    consent_id: row.consentId,
    provider_set: row.providerSetId,
    provider_set_version: row.providerSetVersion,
    features: [...row.features],
    text_version: row.textVersion,
    granted: row.granted,
    recorded_at: toIso(row.recordedAt),
  };
}

function loaded(ctx: RequestContext) {
  const principal = requirePrincipal(ctx);
  if (!ctx.account) throw new Error("the account was not loaded");
  return { principal, account: ctx.account, plan: ctx.plan ?? null };
}

async function creditsOf(deps: Deps, accountId: string): Promise<Credits> {
  const window = await deps.stores.ledger.getCurrentWindow(accountId, deps.clock.now());
  if (!window || window.revokedAt !== null) return { limit: 0, used: 0, reserved: 0, remaining: 0, resets_at: null };
  return {
    limit: window.limit,
    used: window.used,
    reserved: window.reserved,
    remaining: Math.max(0, window.limit - window.used - window.reserved),
    resets_at: toIso(window.end),
  };
}

export function getAccountHandler(deps: Deps): Handler {
  return async (ctx) => {
    const { account, plan } = loaded(ctx);
    const now = deps.clock.now();
    const body: Account = {
      account_id: account.accountId,
      email: account.email,
      login_methods: [...account.loginMethods],
      plan: planObject(plan, now),
      plan_version: account.planVersion,
      credits: await creditsOf(deps, account.accountId),
      consents: (await deps.stores.consents.listActive(account.accountId)).map(consentRecord),
      terms_version: account.termsVersion,
      created_at: toIso(account.createdAt),
    };
    return jsonResponse(body, ctx.requestId);
  };
}

export function deleteAccountHandler(deps: Deps): Handler {
  return async (ctx) => {
    const { account } = loaded(ctx);
    const now = deps.clock.now();
    const first = account.status !== "deleting";
    const tombstone = await deps.stores.accounts.markDeleting(account.accountId, now);
    if (!tombstone) throw new ApiError("session_revoked");
    // Naturally idempotent: a repeated call returns the same 202 (same deletion id) and does not mail again.
    if (first) {
      ctx.waitUntil(
        deps.auth.email.send({ kind: "account_deletion_started", to: account.email }).catch(() => console.error("email send failed")),
      );
    }
    const body: DeletionResponse = { deletion_id: await deletionId(deps, account.accountId, tombstone.createdAt), state: "deleting" };
    // Cancel the subscription and, when that succeeded, purge. If it did not, the retry job takes over.
    if (first) await attemptDeletion(deps, account.accountId);
    return jsonResponse(body, ctx.requestId, { status: 202 });
  };
}

const EXPORTS_PER_DAY = 3;

export function exportAccountHandler(deps: Deps): Handler {
  return async (ctx) => {
    const { account, plan } = loaded(ctx);
    const { stores } = deps;
    const now = deps.clock.now();
    // "Rate limited to a few per day."
    const limited = await stores.rateLimits.hit(`acct:${account.accountId}:export`, EXPORTS_PER_DAY, 24 * 60 * 60 * 1000, now);
    if (!limited.allowed) throw new ApiError("rate_limited", { retryAfterSeconds: limited.retryAfterSeconds ?? 1 });

    const [consents, devices, sessions, usage] = await Promise.all([
      stores.consents.listAll(account.accountId),
      stores.devices.list(account.accountId),
      stores.sessions.listActiveByAccount(account.accountId, now),
      inferenceSeam(deps).usageSnapshot(account.accountId),
    ]);
    const body: AccountExport = {
      account: {
        account_id: account.accountId,
        email: account.email,
        status: account.status,
        google_linked: account.googleSubject !== null,
        created_at: toIso(account.createdAt),
        last_sign_in_at: account.lastSignInAt === null ? null : toIso(account.lastSignInAt),
        last_request_day: account.lastRequestAt === null ? null : toIso(account.lastRequestAt).slice(0, 10),
      },
      login_methods: [...account.loginMethods],
      consent_records: consents.map(consentRecord),
      terms_acceptance: { terms_version: account.termsVersion, accepted_at: toIso(account.termsAcceptedAt) },
      plan: exportPlan(plan, account.planVersion),
      // Device labels and dates only. No token, hash or session id.
      sessions: devices.map((d) => ({
        device_id: d.deviceId,
        label: d.label,
        created_at: toIso(d.createdAt),
        last_used_at: toIso(d.lastUsedAt),
        active: sessions.some((s) => s.deviceId === d.deviceId),
      })),
      usage_totals: [{ credits_used: usage.creditsUsed, window_start: usage.windowStart, window_end: usage.windowEnd }],
    };
    const response = jsonResponse(body, ctx.requestId);
    response.headers.set("Content-Disposition", 'attachment; filename="studentllm-account-export.json"');
    return response;
  };
}

function exportPlan(plan: PlanRecord | null, planVersion: number): Record<string, unknown> {
  if (!plan) return { id: "free", status: "none", plan_version: planVersion, paid_periods: [], cancel_at_period_end: false };
  return {
    id: plan.planId,
    status: plan.status,
    plan_version: planVersion,
    paid_periods: plan.paidPeriods.map((p) => ({ start: toIso(p.start), end: toIso(p.end) })),
    cancel_at_period_end: plan.cancelAtPeriodEnd,
    last_event_at: plan.lastEventAt === null ? null : toIso(plan.lastEventAt),
  };
}

const TERMS_SHAPE = { terms_version: { kind: "string", min: 1, max: 64 } } as const;

export function acceptTermsHandler(deps: Deps): Handler {
  return async (ctx) => {
    const { account } = loaded(ctx);
    const body = parseShape(await ctx.body.json(), TERMS_SHAPE);
    // Only the current version can be accepted; accepting an old one would just be a way to be stuck.
    if (body.terms_version !== deps.config.termsVersion) {
      throw new ApiError("invalid_request", { message: "That is not the current terms version.", details: { terms_version: deps.config.termsVersion } });
    }
    const updated = await deps.stores.accounts.acceptTerms(account.accountId, body.terms_version, deps.clock.now());
    if (!updated) throw new ApiError("session_revoked");
    const result: TermsAcceptance = { terms_version: updated.termsVersion, accepted_at: toIso(updated.termsAcceptedAt) };
    return jsonResponse(result, ctx.requestId);
  };
}

