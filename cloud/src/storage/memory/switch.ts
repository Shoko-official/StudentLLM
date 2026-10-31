import type { Feature, SpendPeriod, SwitchStore, SwitchTarget } from "../interfaces";

const targetKey = (t: SwitchTarget): string => (t.scope === "global" ? "global" : `${t.scope}:${t.name}`);

export class InMemorySwitchStore implements SwitchStore {
  private readonly disabled = new Map<string, SwitchTarget & { since: number }>();
  private readonly spend = new Map<string, number>();
  private readonly counters = new Map<string, number>();

  async setDisabled(target: SwitchTarget, disabled: boolean, now: number) {
    const key = targetKey(target);
    if (disabled) {
      if (!this.disabled.has(key)) this.disabled.set(key, { ...target, since: now });
    } else {
      this.disabled.delete(key);
    }
  }

  async findDisabled(check: { provider?: string; feature?: Feature }) {
    const candidates: SwitchTarget[] = [{ scope: "global" }];
    if (check.feature) candidates.push({ scope: "feature", name: check.feature });
    if (check.provider) candidates.push({ scope: "provider", name: check.provider });
    for (const c of candidates) if (this.disabled.has(targetKey(c))) return c;
    return null;
  }

  async listDisabled() {
    return [...this.disabled.values()].map((t) => ({ ...t }));
  }

  async addSpend(period: SpendPeriod, amount: number) {
    if (!Number.isInteger(amount) || amount < 0) throw new RangeError("amount must be a non-negative integer");
    const total = (this.spend.get(period) ?? 0) + amount;
    this.spend.set(period, total);
    return total;
  }

  async getSpend(period: SpendPeriod) {
    return this.spend.get(period) ?? 0;
  }

  async incrementCounter(name: string, period: SpendPeriod) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new RangeError("invalid counter name");
    const key = `${name}|${period}`;
    const total = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, total);
    return total;
  }

  async getCounter(name: string, period: SpendPeriod) {
    return this.counters.get(`${name}|${period}`) ?? 0;
  }
}
