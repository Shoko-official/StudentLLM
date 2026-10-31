// Kill switches and the global spend cap (docs/cloud-plan.md, "Abuse, fraud and spend limits"). A switch is stored
// in the SwitchStore, usable without a deploy and effective on the next request. A request refused here is
// `kill_switch` (503) and has consumed nothing.

import type { Deps } from "../../deps";
import { ApiError } from "../../http/envelope";
import type { Feature, SpendPeriod } from "../../storage";
import type { ModelRoute, ModelTarget } from "./routing";

export function dayPeriod(ms: number): SpendPeriod {
  return `day:${new Date(ms).toISOString().slice(0, 10)}`;
}

export function monthPeriod(ms: number): SpendPeriod {
  return `month:${new Date(ms).toISOString().slice(0, 7)}`;
}

/** Adds settled credits to the running day and month totals. Zero is a no-op. */
export async function addSpend(deps: Deps, credits: number, now: number): Promise<void> {
  if (credits <= 0) return;
  await Promise.all([deps.stores.switches.addSpend(dayPeriod(now), credits), deps.stores.switches.addSpend(monthPeriod(now), credits)]);
}

/**
 * True when the day or month total has reached the cap, or would pass it with `reserving` more credits (the request
 * about to be reserved). The totals hold SETTLED credits: requests already in flight have reserved but not yet
 * settled, so the cap can be overshot by at most the reservations in flight at that moment (requests in flight x the
 * largest reservation). It stops new requests once reached; it is not an exact ceiling.
 */
export async function spendCapReached(deps: Deps, now: number, reserving = 0): Promise<boolean> {
  const cap = deps.inference.settings.spendCap;
  const [day, month] = await Promise.all([deps.stores.switches.getSpend(dayPeriod(now)), deps.stores.switches.getSpend(monthPeriod(now))]);
  return day >= cap.dayCredits || month >= cap.monthCredits || day + reserving > cap.dayCredits || month + reserving > cap.monthCredits;
}

/**
 * Counts an unknown outcome that was charged in full, by kind and day (a counter, never content). A Workers `fetch`
 * rejection carries no reliable cause, so most network errors land here: the counter shows how many users paid the
 * full reservation for a request that may never have been accepted, which is the signal to revisit that rule.
 */
export async function recordUnknownOutcome(deps: Deps, kind: string, now: number): Promise<void> {
  await recordCounter(deps, `upstream_unknown_${kind}`, now);
}

/** Counts one operational event of the day (a counter, never content, never an account). It never fails a request. */
export async function recordCounter(deps: Deps, name: string, now: number): Promise<void> {
  try {
    await deps.stores.switches.incrementCounter(name, dayPeriod(now));
  } catch {
    // A counter must never fail a request.
  }
}

/** The targets of a model whose provider is not switched off, in order. Empty when nothing can serve it. */
export async function liveTargets(deps: Deps, route: ModelRoute): Promise<ModelTarget[]> {
  const live: ModelTarget[] = [];
  for (const target of route.targets) {
    const off = await deps.stores.switches.findDisabled({ provider: target.providerId, feature: route.feature });
    if (!off) live.push(target);
  }
  return live;
}

/**
 * Throws `kill_switch` when the model is disabled in the routing table, a global or feature switch is on, every
 * provider of the model is switched off, or the global spend cap is reached (or would be passed by the reservation about to be made). Otherwise returns the
 * usable targets.
 */
export async function assertAvailable(deps: Deps, route: ModelRoute, now: number, reserving = 0): Promise<ModelTarget[]> {
  const retry = { retryAfterSeconds: deps.inference.settings.retryAfter.killSwitchSeconds };
  if (!route.enabled) throw new ApiError("kill_switch", retry);
  if (await spendCapReached(deps, now, reserving)) throw new ApiError("kill_switch", retry);
  const targets = await liveTargets(deps, route);
  if (targets.length === 0) throw new ApiError("kill_switch", retry);
  return targets;
}

export interface FeatureAvailability {
  chat: boolean;
  transcription: boolean;
  ocr: boolean;
}

/** For `GET /v1/status`: what can serve each feature right now, and whether anything is degraded. */
export async function featureAvailability(
  deps: Deps,
  now: number,
): Promise<{ features: FeatureAvailability; degraded: boolean; maintenance: boolean }> {
  const switches = deps.stores.switches;
  const off = await switches.listDisabled();
  const maintenance = off.some((s) => s.scope === "global");
  const capped = await spendCapReached(deps, now);
  const features: FeatureAvailability = { chat: false, transcription: false, ocr: false };
  let configuredButDown = false;
  for (const feature of ["chat", "transcription", "ocr"] as const satisfies readonly Feature[]) {
    const configured = deps.inference.routing.models().filter((m) => m.feature === feature);
    let ok = false;
    for (const model of configured) {
      if (model.enabled && !capped && !maintenance && (await liveTargets(deps, model)).length > 0) ok = true;
    }
    features[feature] = ok;
    // A feature the table offers but nothing can serve right now (switched off, or its providers are down).
    if (configured.length > 0 && !ok) configuredButDown = true;
  }
  const anySwitch = off.length > 0;
  return { features, degraded: anySwitch || capped || configuredButDown, maintenance };
}
