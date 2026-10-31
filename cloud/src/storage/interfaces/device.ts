// DeviceStore. Plan rows: "Device counters", "Manage token", and the device half of "Sessions".

export const MAX_DEVICES = 3;
export const MAX_MANAGE_TOKENS_PER_CODE = 3;

export interface DeviceRecord {
  deviceId: string;
  accountId: string;
  /** Platform name, editable. The label is held here only, not duplicated on sessions. */
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface ManageTokenRecord {
  /** SHA-256 of the opaque `mt_` token. The token itself is never stored or logged. */
  tokenHash: string;
  accountId: string;
  expiresAt: number;
  /** Id of the sign-in code that produced it (not the code). */
  codeId: string;
  uses: number;
}

export interface DeviceStore {
  /**
   * The limit check and the device insert as ONE atomic step. A device id that already belongs to the
   * account is refreshed without using a slot; one that belongs to another account is refused.
   */
  register(input: {
    accountId: string;
    deviceId: string;
    label: string;
    now: number;
    limit?: number;
  }): Promise<
    | { ok: true; device: DeviceRecord; created: boolean }
    | { ok: false; reason: "device_limit_reached" | "device_id_taken" }
  >;
  get(accountId: string, deviceId: string): Promise<DeviceRecord | null>;
  list(accountId: string): Promise<DeviceRecord[]>;
  touch(accountId: string, deviceId: string, now: number): Promise<void>;
  /** Revocation applies to the very next request: `isActive` turns false at once. */
  revoke(accountId: string, deviceId: string): Promise<boolean>;
  isActive(accountId: string, deviceId: string): Promise<boolean>;

  /** New-session count per account and day (`dayKey` like `2026-11-01`), for anomaly detection. */
  incrementNewSessions(accountId: string, dayKey: string): Promise<number>;
  getNewSessions(accountId: string, dayKey: string): Promise<number>;
  /** Daily counts are kept 30 days. */
  pruneNewSessions(beforeDayKey: string): Promise<number>;

  /** Stores a manage token unless `MAX_MANAGE_TOKENS_PER_CODE` were already minted for the code. */
  mintManageToken(record: Omit<ManageTokenRecord, "uses">, now: number): Promise<boolean>;
  getManageToken(tokenHash: string, now: number): Promise<ManageTokenRecord | null>;
  recordManageTokenUse(tokenHash: string): Promise<void>;
  deleteExpiredManageTokens(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}
