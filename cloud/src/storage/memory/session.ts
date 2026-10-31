import type { SessionRecord, SessionStore } from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly byCurrent = new Map<string, string>();
  private readonly byPrevious = new Map<string, string>();

  async create(session: SessionRecord) {
    if (this.sessions.has(session.familyId)) throw new Error("session family already exists");
    if (this.byCurrent.has(session.currentHash) || this.byPrevious.has(session.currentHash)) {
      throw new Error("refresh token hash already in use");
    }
    this.sessions.set(session.familyId, copy(session));
    this.byCurrent.set(session.currentHash, session.familyId);
    if (session.prevHash) this.byPrevious.set(session.prevHash, session.familyId);
  }

  async getByFamily(familyId: string) {
    const s = this.sessions.get(familyId);
    return s ? copy(s) : null;
  }

  async findByTokenHash(hash: string) {
    const current = this.byCurrent.get(hash);
    if (current) return { session: copy(this.sessions.get(current)!), match: "current" as const };
    const previous = this.byPrevious.get(hash);
    if (previous) return { session: copy(this.sessions.get(previous)!), match: "previous" as const };
    return null;
  }

  async rotate(
    familyId: string,
    expectedCurrentHash: string,
    next: { newHash: string; graceSuccessor: string | null; now: number; idleExpiresAt: number },
  ) {
    const s = this.sessions.get(familyId);
    if (!s || s.revokedAt !== null || s.currentHash !== expectedCurrentHash) return null;
    if (this.byCurrent.has(next.newHash) || this.byPrevious.has(next.newHash)) return null;
    if (s.prevHash) this.byPrevious.delete(s.prevHash);
    this.byCurrent.delete(s.currentHash);
    s.prevHash = s.currentHash;
    s.rotatedAt = next.now;
    s.currentHash = next.newHash;
    s.graceSuccessor = next.graceSuccessor;
    s.lastUsedAt = next.now;
    s.idleExpiresAt = next.idleExpiresAt;
    this.byCurrent.set(s.currentHash, familyId);
    this.byPrevious.set(s.prevHash, familyId);
    return copy(s);
  }

  async clearGrace(familyId: string) {
    const s = this.sessions.get(familyId);
    if (s) s.graceSuccessor = null;
  }

  async revokeFamily(familyId: string, now: number) {
    const s = this.sessions.get(familyId);
    if (!s || s.revokedAt !== null) return false;
    s.revokedAt = now;
    s.graceSuccessor = null;
    return true;
  }

  async revokeByDevice(accountId: string, deviceId: string, now: number) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId && s.deviceId === deviceId && s.revokedAt === null) {
        s.revokedAt = now;
        s.graceSuccessor = null;
        n++;
      }
    }
    return n;
  }

  async revokeAllForAccount(accountId: string, now: number) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId && s.revokedAt === null) {
        s.revokedAt = now;
        s.graceSuccessor = null;
        n++;
      }
    }
    return n;
  }

  async listActiveByAccount(accountId: string, now: number) {
    return [...this.sessions.values()]
      .filter((s) => s.accountId === accountId && s.revokedAt === null && s.idleExpiresAt > now && s.absoluteExpiresAt > now)
      .map(copy);
  }

  async deleteExpired(now: number) {
    let n = 0;
    for (const s of [...this.sessions.values()]) {
      if (s.revokedAt !== null || s.idleExpiresAt <= now || s.absoluteExpiresAt <= now) {
        this.remove(s);
        n++;
      }
    }
    return n;
  }

  async purgeAccount(accountId: string) {
    for (const s of [...this.sessions.values()]) if (s.accountId === accountId) this.remove(s);
  }

  private remove(s: SessionRecord) {
    this.sessions.delete(s.familyId);
    this.byCurrent.delete(s.currentHash);
    if (s.prevHash) this.byPrevious.delete(s.prevHash);
  }
}
