import { randomToken } from "../../crypto/random";
import type { ConcurrencyLease, ConcurrencyStore } from "../interfaces";

export class InMemoryConcurrencyStore implements ConcurrencyStore {
  private readonly leases = new Map<string, ConcurrencyLease>();

  private live(accountId: string, now: number): ConcurrencyLease[] {
    return [...this.leases.values()].filter((l) => l.accountId === accountId && l.expiresAt > now);
  }

  async acquire(accountId: string, max: number, leaseMs: number, now: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
    for (const [id, l] of [...this.leases]) if (l.expiresAt <= now) this.leases.delete(id);
    if (this.live(accountId, now).length >= max) return null;
    const lease: ConcurrencyLease = { id: randomToken("ls_", 16), accountId, expiresAt: now + leaseMs };
    this.leases.set(lease.id, lease);
    return { ...lease };
  }

  async renew(lease: ConcurrencyLease, leaseMs: number, now: number) {
    const current = this.leases.get(lease.id);
    if (!current || current.expiresAt <= now) return null;
    current.expiresAt = now + leaseMs;
    return { ...current };
  }

  async release(lease: ConcurrencyLease) {
    return this.leases.delete(lease.id);
  }

  async activeCount(accountId: string, now: number) {
    return this.live(accountId, now).length;
  }

  async purgeAccount(accountId: string) {
    for (const [id, l] of [...this.leases]) if (l.accountId === accountId) this.leases.delete(id);
  }
}
