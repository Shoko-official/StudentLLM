import { constantTimeEqual } from "../../crypto/compare";
import type { SaltedHash, StableHash } from "../../crypto/keyed-hash";
import type { AuthChallengeStore, LinkTicket, PendingSignIn, VerifyEmailCodeResult } from "../interfaces";

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

  async getByEmailHash(emailHash: StableHash, now: number) {
    return this.find((p) => p.emailHash === emailHash, now);
  }

  async getByCodeHash(codeHash: string, now: number) {
    return this.find((p) => p.codeHash === codeHash, now);
  }

  async verifyEmailCode(input: {
    emailHash: StableHash;
    candidateCodeHash: string;
    maxAttempts: number;
    consume: boolean;
    now: number;
  }): Promise<VerifyEmailCodeResult> {
    // One synchronous step: read, compare, count and consume cannot interleave with another guess.
    let p: PendingSignIn | undefined;
    for (const candidate of this.pending.values()) {
      if (candidate.kind === "email" && candidate.emailHash === input.emailHash && candidate.expiresAt > input.now) p = candidate;
    }
    if (!p) return { outcome: "gone" };
    if (p.attempts >= input.maxAttempts) return { outcome: "locked" };
    if (p.codeHash === null || !constantTimeEqual(p.codeHash, input.candidateCodeHash)) {
      p.attempts += 1;
      return { outcome: "wrong", attempts: p.attempts };
    }
    const pending = copy(p);
    if (input.consume) this.pending.delete(p.id);
    return { outcome: "ok", pending };
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

  async getLinkTicket(ticketHash: string, now: number) {
    const t = this.tickets.get(ticketHash);
    return t && !t.used && t.expiresAt > now ? copy(t) : null;
  }

  async consumeLinkTicket(ticketHash: string, now: number) {
    const t = this.tickets.get(ticketHash);
    if (!t || t.used || t.expiresAt <= now) return null;
    t.used = true;
    const out = copy(t);
    this.tickets.delete(ticketHash);
    return out;
  }

  async incrementCounter(key: SaltedHash, now: number, ttlMs: number) {
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.counters.set(key, { count: 1, expiresAt: now + ttlMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  async getCounter(key: SaltedHash, now: number) {
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
