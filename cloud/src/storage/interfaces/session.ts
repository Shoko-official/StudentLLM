// SessionStore. Plan row: "Sessions" (the device id and label half lives in DeviceStore).

export interface SessionRecord {
  /** Refresh family id (the access token's `sid`). */
  familyId: string;
  accountId: string;
  deviceId: string;
  /** Hash of the current refresh token. */
  currentHash: string;
  /** Hash and rotation time of the previous token, for reuse detection and the retry grace window. */
  prevHash: string | null;
  rotatedAt: number | null;
  /** The successor token encrypted under a key derived from the previous token; erased after the grace window. */
  graceSuccessor: string | null;
  /** Time of the last fresh sign-in; a refresh copies it unchanged. */
  authTime: number;
  createdAt: number;
  lastUsedAt: number;
  /** 30 days idle. */
  idleExpiresAt: number;
  /** 180 days absolute. */
  absoluteExpiresAt: number;
  revokedAt: number | null;
}

export interface SessionStore {
  create(session: SessionRecord): Promise<void>;
  getByFamily(familyId: string): Promise<SessionRecord | null>;
  /** Finds the family that owns this refresh token hash, as its current or its previous token. */
  findByTokenHash(hash: string): Promise<{ session: SessionRecord; match: "current" | "previous" } | null>;
  /**
   * Compare-and-set rotation: only succeeds while `expectedCurrentHash` is still current and the family is
   * not revoked. The old current hash becomes `prevHash`.
   */
  rotate(
    familyId: string,
    expectedCurrentHash: string,
    next: { newHash: string; graceSuccessor: string | null; now: number; idleExpiresAt: number },
  ): Promise<SessionRecord | null>;
  /** Erases the encrypted successor (grace window over, or the successor was used). */
  clearGrace(familyId: string): Promise<void>;
  revokeFamily(familyId: string, now: number): Promise<boolean>;
  revokeByDevice(accountId: string, deviceId: string, now: number): Promise<number>;
  revokeAllForAccount(accountId: string, now: number): Promise<number>;
  /** Sessions that are neither revoked nor expired. */
  listActiveByAccount(accountId: string, now: number): Promise<SessionRecord[]>;
  /** Deletes expired and revoked sessions ("until expiry or revocation, then deleted"). */
  deleteExpired(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}
