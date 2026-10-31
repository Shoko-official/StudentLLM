import type { ConsentRow, ConsentStore, NewConsent } from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

const sameFeatures = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/** Append-only: rows are never changed or removed (except when the whole account is purged). */
export class InMemoryConsentStore implements ConsentStore {
  private readonly rows: ConsentRow[] = [];

  private latest(accountId: string, providerSetId: string): ConsentRow | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.accountId === accountId && r.providerSetId === providerSetId) return r;
    }
    return undefined;
  }

  async record(input: NewConsent, now: number) {
    const latest = this.latest(input.accountId, input.providerSetId);
    if (
      latest &&
      latest.granted === input.granted &&
      latest.providerSetVersion === input.providerSetVersion &&
      latest.textVersion === input.textVersion &&
      sameFeatures(latest.features, input.features)
    ) {
      return { row: copy(latest), created: false };
    }
    if (this.rows.some((r) => r.consentId === input.consentId)) throw new Error("consent id already exists");
    const row: ConsentRow = { ...copy(input), recordedAt: now };
    this.rows.push(row);
    return { row: copy(row), created: true };
  }

  async getActive(accountId: string, providerSetId: string) {
    const latest = this.latest(accountId, providerSetId);
    return latest && latest.granted ? copy(latest) : null;
  }

  async getById(accountId: string, consentId: string) {
    const row = this.rows.find((r) => r.accountId === accountId && r.consentId === consentId);
    return row ? copy(row) : null;
  }

  async listActive(accountId: string) {
    const sets = new Set(this.rows.filter((r) => r.accountId === accountId).map((r) => r.providerSetId));
    const out: ConsentRow[] = [];
    for (const set of sets) {
      const latest = this.latest(accountId, set);
      if (latest?.granted) out.push(copy(latest));
    }
    return out;
  }

  async listAll(accountId: string) {
    return this.rows.filter((r) => r.accountId === accountId).map(copy);
  }

  async purgeAccount(accountId: string) {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.accountId === accountId) this.rows.splice(i, 1);
  }
}
