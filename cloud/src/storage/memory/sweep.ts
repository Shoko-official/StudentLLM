import type { SweepRegistry } from "../interfaces";

export class InMemorySweepRegistry implements SweepRegistry {
  private readonly dueAt = new Map<string, number>();

  async schedule(accountId: string, atMs: number) {
    const existing = this.dueAt.get(accountId);
    if (existing === undefined || atMs < existing) this.dueAt.set(accountId, atMs);
  }

  async reschedule(accountId: string, atMs: number | null) {
    if (atMs === null) this.dueAt.delete(accountId);
    else this.dueAt.set(accountId, atMs);
  }

  async clear(accountId: string) {
    this.dueAt.delete(accountId);
  }

  async due(now: number, limit: number) {
    return [...this.dueAt.entries()]
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id]) => id);
  }
}
