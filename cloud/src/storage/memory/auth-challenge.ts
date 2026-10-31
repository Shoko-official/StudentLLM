import type { AuthChallengeStore, LinkTicket, PendingSignIn } from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryAuthChallengeStore implements AuthChallengeStore {
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly tickets = new Map<string, LinkTicket>();
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  async put(p: PendingSignIn) {
    this.pending.set(p.id, copy(p));
  }

  async replaceForEmail(p: PendingSignIn) {
    if (p.emailHash === null) throw new TypeError("replaceForEmail needs an emailHash");
    for (const [id, existing] of [...this.pending]) {
      if (existing.emailHash === p.emailHash) this.pending.delete(id);
    }
    this.pending.set(p.id, copy(p));
  }

  private find(predicate: (p: PendingSignIn) => boolean, now: number): PendingSignIn | null {
    for (const p of this.pending.values()) {
      if (p.expiresAt > now && predicate(p)) return copy(p);
    }
    return null;
  }

  async getByStateHash(stateHash: string, now: number) {
    return this.find((p) => p.stateHash === stateHash, now);
  }

  async getByEmailHash(emailHash: string, now: number) {
    return this.find((p) => p.emailHash === emailHash, now);
  }

  async getByCodeHash(codeHash: string, now: number) {
    return this.find((p) => p.codeHash === codeHash, now);
  }

  async incrementAttempts(id: string) {
    const p = this.pending.get(id);
    if (!p) return null;
    p.attempts += 1;
    return p.attempts;
  }

  async delete(id: string) {
    this.pending.delete(id);
  }

  async consume(id: string, now: number) {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    return p.expiresAt > now ? copy(p) : null;
  }

  async putLinkTicket(ticket: LinkTicket) {
    this.tickets.set(ticket.ticketHash, copy(ticket));
  }

  async consumeLinkTicket(ticketHash: string, now: number) {
    const t = this.tickets.get(ticketHash);
    if (!t || t.used || t.expiresAt <= now) return null;
    t.used = true;
    const out = copy(t);
    this.tickets.delete(ticketHash);
    return out;
  }

  async incrementCounter(key: string, now: number, ttlMs: number) {
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.counters.set(key, { count: 1, expiresAt: now + ttlMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  async getCounter(key: string, now: number) {
    const c = this.counters.get(key);
    return c && c.expiresAt > now ? c.count : 0;
  }

  async deleteExpired(now: number) {
    let n = 0;
    for (const [id, p] of [...this.pending]) if (p.expiresAt <= now) (this.pending.delete(id), n++);
    for (const [h, t] of [...this.tickets]) if (t.expiresAt <= now) (this.tickets.delete(h), n++);
    for (const [k, c] of [...this.counters]) if (c.expiresAt <= now) (this.counters.delete(k), n++);
    return n;
  }

  async purgeAccount(accountId: string) {
    for (const [id, p] of [...this.pending]) if (p.accountId === accountId) this.pending.delete(id);
    for (const [h, t] of [...this.tickets]) if (t.accountId === accountId) this.tickets.delete(h);
  }
}
