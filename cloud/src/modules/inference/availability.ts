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

/** True when the day or month total reached the cap: the hard stop. */
export async function spendCapReached(deps: Deps, now: number): Promise<boolean> {
  const cap = deps.inference.settings.spendCap;
  const [day, month] = await Promise.all([deps.stores.switches.getSpend(dayPeriod(now)), deps.stores.switches.getSpend(monthPeriod(now))]);
  return day >= cap.dayCredits || month >= cap.monthCredits;
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
 * provider of the model is switched off, or the global spend cap is reached. Otherwise returns the usable targets.
 */
export async function assertAvailable(deps: Deps, route: ModelRoute, now: number): Promise<ModelTarget[]> {
  const retry = { retryAfterSeconds: deps.inference.settings.retryAfter.killSwitchSeconds };
  if (!route.enabled) throw new ApiError("kill_switch", retry);
  if (await spendCapReached(deps, now)) throw new ApiError("kill_switch", retry);
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
