// One attempt at a content request, from the budget reservation to its settlement. It is the single place where
// the handlers touch the ledger, so the rules of docs/cloud-plan.md ("Reserve then settle") live in one file:
//
// - the reservation is made AFTER the body was validated (step 10 of the check order), with a time to live of the
//   route's maximum duration plus a 60 second margin, extended by a heartbeat while a stream makes progress;
// - an account with a plan but no window yet gets its window lazily (`ensureWindow`), never reset;
// - `markForwarded` comes BEFORE the upstream call, so a crash after it settles at the full reservation;
// - the first settlement wins, and a settlement is capped at the reservation;
// - a failure before the forward keeps the reservation (`failed_before_forward`, a same-key retry reuses it),
//   a definitive provider failure releases it (`failed_no_usage`, zero credits).

import type { RequestContext } from "../../http/context";
import { requirePrincipal } from "../../http/context";
import { ApiError } from "../../http/envelope";
import type { Reservation } from "../../storage";
import { addSpend } from "./availability";
import type { ModelRoute } from "./routing";
import { sweepAccount } from "./sweeper";
import { formatTime } from "./time";
import { lazyWindowSpec } from "./window";

export { formatTime };

export interface Meter {
  /** Credits left in the window after this attempt's reservation (or settlement). */
  remaining: number;
  limit: number;
  resetsAt: number;
}

export interface SettleSummary extends Meter {
  charged: number;
}

export function setCreditHeaders(ctx: RequestContext, meter: Meter): void {
  ctx.responseHeaders.set("X-StudentLLM-Credits-Remaining", String(meter.remaining));
  ctx.responseHeaders.set("X-StudentLLM-Credits-Limit", String(meter.limit));
  ctx.responseHeaders.set("X-StudentLLM-Credits-Reset", formatTime(meter.resetsAt));
}

type AttemptState = "reserved" | "forwarded" | "closed";

export class Attempt {
  /** The request id that owns the reservation (the original one after a `failed_before_forward` retry). */
  readonly requestId: string;
  private state: AttemptState = "reserved";

  private constructor(
    private readonly ctx: RequestContext,
    private readonly accountId: string,
    readonly route: ModelRoute,
    readonly reservation: Reservation,
    private meter: Meter,
  ) {
    this.requestId = reservation.requestId;
  }

  get reservedCredits(): number {
    return this.reservation.credits;
  }

  /** The meter right after the reservation, for the credit headers of a stream. */
  get reservedMeter(): Meter {
    return this.meter;
  }

  get forwarded(): boolean {
    return this.state !== "reserved";
  }

  /** True while the attempt owns an open reservation (nothing settled or released yet). */
  get open(): boolean {
    return this.state !== "closed";
  }

  static async open(ctx: RequestContext, input: { route: ModelRoute; credits: number }): Promise<Attempt> {
    const { deps } = ctx;
    const { ledger, idempotency } = deps.stores;
    const accountId = requirePrincipal(ctx).accountId;
    const idem = ctx.locals.idem;
    if (!idem) throw new Error("content route reached without an idempotency record");
    const { route } = input;
    const now = deps.clock.now();
    const expiresAt = now + route.maxDurationMs + deps.inference.settings.reservationMarginMs;
    const inProgress = () =>
      new ApiError("idempotency_conflict", {
        message: "A request with this key is still in progress.",
        retryAfterSeconds: deps.inference.settings.retryAfter.inProgressSeconds,
        details: { state: "in_progress", request_id: idem.ownerRequestId },
      });

    // A same-key retry after failed_before_forward reuses the reservation the first attempt kept.
    if (idem.reuseReservation) {
      const existing = await ledger.getReservation(accountId, idem.ownerRequestId);
      if (existing) {
        if (existing.state !== "reserved") throw new ApiError("internal_error");
        if (existing.credits >= input.credits && existing.feature === route.feature) {
          if (!(await ledger.extendReservation(accountId, idem.ownerRequestId, expiresAt))) throw new ApiError("internal_error");
          const meter = await meterOf(deps, accountId, now);
          return new Attempt(ctx, accountId, route, existing, meter);
        }
        // The retry needs more than was reserved (a different body under the same key): release the old
        // reservation and start a new attempt, so the charge cannot be capped below what this request costs.
        await ledger.release(accountId, idem.ownerRequestId, now);
        const again = await idempotency.begin(idem.key, ctx.requestId, now, idem.leaseMs);
        if (again.outcome !== "retry") throw inProgress();
        idem.ownerRequestId = again.record.requestId;
        idem.reuseReservation = false;
      }
    }

    const reserveOnce = () =>
      ledger.reserve(accountId, {
        requestId: idem.ownerRequestId,
        feature: route.feature,
        logicalModelId: route.id,
        credits: input.credits,
        now,
        expiresAt,
        idempotency: idem.ref,
      });

    let result = await reserveOnce();
    if (!result.ok && result.reason === "no_window") {
      // The window is created lazily from the paid period. Without a covering period there is no plan to spend.
      const spec = lazyWindowSpec(deps, ctx.plan ?? null, now);
      if (!spec) throw new ApiError("plan_required");
      await ledger.ensureWindow(accountId, spec);
      result = await reserveOnce();
    }
    if (!result.ok && result.reason === "budget_exhausted") {
      // Expired reservations of this account may still hold budget: reconcile on access, then look again.
      await sweepAccount(deps, accountId);
      result = await reserveOnce();
    }
    if (!result.ok) {
      switch (result.reason) {
        case "duplicate_request":
          // Another attempt of the same key already holds this request id.
          throw inProgress();
        case "no_window":
          throw new ApiError("plan_required");
        case "budget_exhausted": {
          const window = await ledger.getCurrentWindow(accountId, now);
          const meter: Meter = { remaining: result.remaining, limit: window?.limit ?? 0, resetsAt: result.resetsAt };
          setCreditHeaders(ctx, meter);
          throw new ApiError("budget_exhausted", {
            retryAfterSeconds: Math.max(1, Math.ceil((result.resetsAt - now) / 1000)),
            details: { resets_at: formatTime(result.resetsAt) },
          });
        }
      }
    }
    const window = await ledger.getCurrentWindow(accountId, now);
    const meter: Meter = { remaining: result.remaining, limit: window?.limit ?? result.remaining, resetsAt: result.resetsAt };
    return new Attempt(ctx, accountId, route, result.reservation, meter);
  }

  /** Call BEFORE the upstream request is sent: from here on an unknown outcome is charged in full. */
  async markForwarded(): Promise<void> {
    if (this.state !== "reserved") return;
    if (!(await this.ctx.deps.stores.ledger.markForwarded(this.accountId, this.requestId))) throw new ApiError("internal_error");
    this.state = "forwarded";
  }

  /** Heartbeat of a stream that makes progress: keeps the reservation out of the sweep. */
  async heartbeat(): Promise<void> {
    if (this.state === "closed") return;
    const { deps } = this.ctx;
    const now = deps.clock.now();
    await deps.stores.ledger.extendReservation(
      this.accountId,
      this.requestId,
      now + this.route.maxDurationMs + deps.inference.settings.reservationMarginMs,
    );
  }

  /** Settles `credits` (capped at the reservation by the ledger). The first settlement wins. */
  async settle(credits: number): Promise<SettleSummary> {
    const { deps } = this.ctx;
    const now = deps.clock.now();
    this.state = "closed";
    const result = await deps.stores.ledger.settle(this.accountId, { requestId: this.requestId, credits, logicalModelId: this.route.id, now });
    let charged: number;
    if (result.settled) {
      charged = result.charged;
      await addSpend(deps, charged, now);
    } else if (result.reason === "duplicate") {
      // The sweep got there first (an unknown outcome charged in full): report what was charged.
      charged = (await deps.stores.ledger.getLedgerEntry(this.accountId, this.requestId))?.credits ?? credits;
    } else {
      charged = 0;
    }
    this.ctx.creditsCharged = charged;
    return { charged, ...(await this.currentMeter(now)) };
  }

  /** `failed_no_usage`: a definitive provider failure. Zero credits, the same key may be retried. */
  async releaseNoUsage(): Promise<SettleSummary> {
    const { deps } = this.ctx;
    const now = deps.clock.now();
    this.state = "closed";
    await deps.stores.ledger.release(this.accountId, this.requestId, now);
    this.ctx.creditsCharged = 0;
    return { charged: 0, ...(await this.currentMeter(now)) };
  }

  /** Something failed before the request was forwarded: keep the reservation for a same-key retry. */
  async failBeforeForward(): Promise<void> {
    if (this.state !== "reserved") return;
    this.state = "closed";
    await this.ctx.deps.stores.ledger.markFailedBeforeForward(this.accountId, this.requestId, this.ctx.deps.clock.now());
  }

  private async currentMeter(now: number): Promise<Meter> {
    const window = await this.ctx.deps.stores.ledger.getCurrentWindow(this.accountId, now);
    if (!window) return { remaining: 0, limit: this.meter.limit, resetsAt: this.meter.resetsAt };
    this.meter = { remaining: Math.max(0, window.limit - window.used - window.reserved), limit: window.limit, resetsAt: window.end };
    return this.meter;
  }
}

async function meterOf(deps: RequestContext["deps"], accountId: string, now: number): Promise<Meter> {
  const window = await deps.stores.ledger.getCurrentWindow(accountId, now);
  if (!window) return { remaining: 0, limit: 0, resetsAt: now };
  return { remaining: Math.max(0, window.limit - window.used - window.reserved), limit: window.limit, resetsAt: window.end };
}
