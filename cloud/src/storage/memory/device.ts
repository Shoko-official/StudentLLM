import { MAX_DEVICES, MAX_MANAGE_TOKENS_PER_CODE, type DeviceRecord, type DeviceStore, type ManageTokenRecord } from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryDeviceStore implements DeviceStore {
  private readonly devices = new Map<string, DeviceRecord>(); // key: deviceId (globally unique)
  private readonly newSessions = new Map<string, number>(); // key: accountId|dayKey
  private readonly manageTokens = new Map<string, ManageTokenRecord>();
  private readonly mintedPerCode = new Map<string, number>();

  async register(input: { accountId: string; deviceId: string; label: string; now: number; limit?: number }) {
    const limit = input.limit ?? MAX_DEVICES;
    const existing = this.devices.get(input.deviceId);
    if (existing) {
      if (existing.accountId !== input.accountId) return { ok: false as const, reason: "device_id_taken" as const };
      existing.lastUsedAt = input.now;
      return { ok: true as const, device: copy(existing), created: false };
    }
    const count = [...this.devices.values()].filter((d) => d.accountId === input.accountId).length;
    if (count >= limit) return { ok: false as const, reason: "device_limit_reached" as const };
    const device: DeviceRecord = {
      deviceId: input.deviceId,
      accountId: input.accountId,
      label: input.label,
      createdAt: input.now,
      lastUsedAt: input.now,
    };
    this.devices.set(device.deviceId, device);
    return { ok: true as const, device: copy(device), created: true };
  }

  async get(accountId: string, deviceId: string) {
    const d = this.devices.get(deviceId);
    return d && d.accountId === accountId ? copy(d) : null;
  }

  async list(accountId: string) {
    return [...this.devices.values()].filter((d) => d.accountId === accountId).map(copy);
  }

  async touch(accountId: string, deviceId: string, now: number) {
    const d = this.devices.get(deviceId);
    if (d && d.accountId === accountId) d.lastUsedAt = now;
  }

  async revoke(accountId: string, deviceId: string) {
    const d = this.devices.get(deviceId);
    if (!d || d.accountId !== accountId) return false;
    this.devices.delete(deviceId);
    return true;
  }

  async isActive(accountId: string, deviceId: string) {
    const d = this.devices.get(deviceId);
    return d !== undefined && d.accountId === accountId;
  }

  async incrementNewSessions(accountId: string, dayKey: string) {
    const key = `${accountId}|${dayKey}`;
    const n = (this.newSessions.get(key) ?? 0) + 1;
    this.newSessions.set(key, n);
    return n;
  }

  async getNewSessions(accountId: string, dayKey: string) {
    return this.newSessions.get(`${accountId}|${dayKey}`) ?? 0;
  }

  async pruneNewSessions(beforeDayKey: string) {
    let n = 0;
    for (const key of [...this.newSessions.keys()]) {
      const day = key.slice(key.lastIndexOf("|") + 1);
      if (day < beforeDayKey) {
        this.newSessions.delete(key);
        n++;
      }
    }
    return n;
  }

  async mintManageToken(record: Omit<ManageTokenRecord, "uses">, _now: number) {
    const minted = this.mintedPerCode.get(record.codeId) ?? 0;
    if (minted >= MAX_MANAGE_TOKENS_PER_CODE || this.manageTokens.has(record.tokenHash)) return false;
    this.mintedPerCode.set(record.codeId, minted + 1);
    this.manageTokens.set(record.tokenHash, { ...record, uses: 0 });
    return true;
  }

  async getManageToken(tokenHash: string, now: number) {
    const t = this.manageTokens.get(tokenHash);
    return t && t.expiresAt > now ? copy(t) : null;
  }

  async recordManageTokenUse(tokenHash: string) {
    const t = this.manageTokens.get(tokenHash);
    if (t) t.uses += 1;
  }

  async revokeManageTokens(accountId: string) {
    let n = 0;
    for (const [hash, t] of [...this.manageTokens]) {
      // The per-code mint counter is kept: a revoked token must not make room for a fourth one.
      if (t.accountId === accountId) {
        this.manageTokens.delete(hash);
        n++;
      }
    }
    return n;
  }

  async deleteExpiredManageTokens(now: number) {
    let n = 0;
    for (const [hash, t] of [...this.manageTokens]) {
      if (t.expiresAt <= now) {
        this.manageTokens.delete(hash);
        n++;
      }
    }
    return n;
  }

  async purgeAccount(accountId: string) {
    for (const [id, d] of [...this.devices]) if (d.accountId === accountId) this.devices.delete(id);
    for (const key of [...this.newSessions.keys()]) if (key.startsWith(`${accountId}|`)) this.newSessions.delete(key);
    for (const [hash, t] of [...this.manageTokens]) {
      if (t.accountId === accountId) {
        this.manageTokens.delete(hash);
        this.mintedPerCode.delete(t.codeId);
      }
    }
  }
}
