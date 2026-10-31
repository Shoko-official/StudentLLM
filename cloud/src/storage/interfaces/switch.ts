// SwitchStore: kill switches (per provider, per feature, global) and the global spend counters.
// Plan: "Abuse, fraud and spend limits" (global spend cap, kill switch usable without a deploy and
// effective within seconds). Not account data; one global record set (a small Durable Object).

import type { Feature } from "./common";

export type SwitchTarget =
  | { scope: "global" }
  | { scope: "provider"; name: string }
  | { scope: "feature"; name: Feature };

/** `day:2026-11-01` or `month:2026-11`. */
export type SpendPeriod = `day:${string}` | `month:${string}`;

export interface SwitchStore {
  setDisabled(target: SwitchTarget, disabled: boolean, now: number): Promise<void>;
  /** The first disabled switch that applies (global, then the feature, then the provider), or null. */
  findDisabled(check: { provider?: string; feature?: Feature }): Promise<SwitchTarget | null>;
  listDisabled(): Promise<Array<SwitchTarget & { since: number }>>;

  /** Adds an integer amount (cost-normalized credits) to the running total and returns the new total. Atomic. */
  addSpend(period: SpendPeriod, amount: number): Promise<number>;
  getSpend(period: SpendPeriod): Promise<number>;
}
