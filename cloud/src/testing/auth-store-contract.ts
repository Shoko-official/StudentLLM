// Test-only: behavior of the store methods that the auth and account modules added on top of the shared
// suite in store-contract.ts (grace clearing, manage-token revocation, deletion retry bookkeeping, the
// pending sign-in columns and the register-then-consume flow). Adapters run it with their own factory:
//
//   runAuthStoreContract("in-memory", () => createInMemoryStores());
//   runAuthStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores()));

import { describe, expect, it } from "vitest";
import type { StableHash } from "../crypto/keyed-hash";
import type { PendingSignIn, SessionRecord, Stores } from "../storage";
import type { StoreFactory } from "./store-contract";

const T0 = Date.UTC(2026, 10, 1);

export function runAuthStoreContract(label: string, factory: StoreFactory): void {
  const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    familyId: "fam_1", accountId: "a", deviceId: "d1", currentHash: "h1", prevHash: null, rotatedAt: null, graceSuccessor: null,
    authTime: T0, createdAt: T0, lastUsedAt: T0, idleExpiresAt: T0 + 30 * 86_400_000, absoluteExpiresAt: T0 + 180 * 86_400_000,
    revokedAt: null, ...over,
  });

  describe(`${label}: auth additions`, () => {
    it("clears the encrypted successor once the grace window is over, and only then", async () => {
      const { sessions } = factory();
      await sessions.create(session());
      await sessions.create(session({ familyId: "fam_2", currentHash: "x1", deviceId: "d2" }));
      await sessions.rotate("fam_1", "h1", { newHash: "h2", graceSuccessor: "enc", now: T0 + 1000, idleExpiresAt: T0 + 9e9 });
      await sessions.rotate("fam_2", "x1", { newHash: "x2", graceSuccessor: "enc2", now: T0 + 25_000, idleExpiresAt: T0 + 9e9 });
      expect(await sessions.clearExpiredGrace(T0 + 20_000, 30_000)).toBe(0);
      expect((await sessions.getByFamily("fam_1"))!.graceSuccessor).toBe("enc");
      expect(await sessions.clearExpiredGrace(T0 + 31_000, 30_000)).toBe(1);
      expect((await sessions.getByFamily("fam_1"))!.graceSuccessor).toBeNull();
      expect((await sessions.getByFamily("fam_2"))!.graceSuccessor).toBe("enc2");
      // The hashes stay so a late reuse is still detected.
      expect((await sessions.findByTokenHash("h1"))!.match).toBe("previous");
    });

    it("revokes every manage token of an account without making room for a fourth one for the same code", async () => {
      const { devices } = factory();
      const mk = (n: number, accountId = "a", codeId = "code_1") => ({ tokenHash: `th${n}`, accountId, expiresAt: T0 + 300_000, codeId });
      for (const n of [1, 2, 3]) expect(await devices.mintManageToken(mk(n), T0)).toBe(true);
      expect(await devices.mintManageToken(mk(9, "b", "code_2"), T0)).toBe(true);
      expect(await devices.revokeManageTokens("a")).toBe(3);
      expect(await devices.getManageToken("th1", T0)).toBeNull();
      expect(await devices.getManageToken("th9", T0)).not.toBeNull();
      expect(await devices.mintManageToken(mk(4), T0)).toBe(false);
    });

    it("tracks the deletion retry schedule on the tombstone", async () => {
      const { accounts } = factory();
      await accounts.create({ accountId: "a", email: "a@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 });
      const t = await accounts.markDeleting("a", T0);
      expect(Object.keys(t!).sort()).toEqual(["accountId", "createdAt", "paddleCustomerId", "paddleSubscriptionId"]);
      expect((await accounts.listDueDeletions(T0, 10)).map((j) => j.tombstone.accountId)).toEqual(["a"]);
      expect(await accounts.recordCancelAttempt("a", T0 + 60_000)).toMatchObject({ cancelAttempts: 1, nextAttemptAt: T0 + 60_000 });
      expect(await accounts.listDueDeletions(T0 + 59_999, 10)).toEqual([]);
      expect((await accounts.listDueDeletions(T0 + 60_000, 10)).map((j) => j.tombstone.accountId)).toEqual(["a"]);
      await accounts.markDeleting("a", T0 + 5); // idempotent: the counters stay
      expect((await accounts.listDueDeletions(T0 + 60_000, 10))[0]).toMatchObject({ cancelAttempts: 1 });
      await accounts.purgeAccount("a");
      expect(await accounts.recordCancelAttempt("a", T0)).toBeNull();
      expect(await accounts.listDueDeletions(T0 + 1e9, 10)).toEqual([]);
    });

    it("carries the redirect URI, the app state and the device label through a pending sign-in", async () => {
      const { authChallenges } = factory();
      const pending: PendingSignIn = {
        id: "g1", kind: "google", stateHash: "sh", emailHash: null, codeChallenge: "cc", redirectType: "loopback",
        redirectUri: "http://127.0.0.1:50321/callback", appState: "app-state-0123456789", deviceLabel: "Laptop",
        termsVersion: "v1", linkTicketId: null, codeHash: null, accountId: null, attempts: 0, resends: 0, createdAt: T0, expiresAt: T0 + 600_000,
      };
      await authChallenges.put(pending);
      expect(await authChallenges.getByStateHash("sh", T0)).toEqual(pending);
    });
  });

  describe(`${label}: register, then consume (parallel redemptions of one code)`, () => {
    const EH = "eh" as StableHash;
    const setup = async (stores: Stores) => {
      await stores.authChallenges.put({
        id: "p1", kind: "email", stateHash: null, emailHash: EH, codeChallenge: "cc", redirectType: null, redirectUri: null, appState: null,
        deviceLabel: null, termsVersion: "v1", linkTicketId: null, codeHash: "right", accountId: null, attempts: 0, resends: 0,
        createdAt: T0, expiresAt: T0 + 600_000,
      });
    };

    it("leaves exactly one device behind when the same code is redeemed by several callers", async () => {
      const stores = factory();
      await setup(stores);
      const redeem = async (deviceId: string) => {
        const check = await stores.authChallenges.verifyEmailCode({ emailHash: EH, candidateCodeHash: "right", maxAttempts: 5, consume: false, now: T0 });
        if (check.outcome !== "ok") return "invalid";
        const reg = await stores.devices.register({ accountId: "a", deviceId, label: deviceId, now: T0 });
        if (!reg.ok) return "limit";
        const consumed = await stores.authChallenges.consume(check.pending.id, T0);
        if (!consumed) {
          if (reg.created) await stores.devices.revoke("a", deviceId);
          return "lost";
        }
        return "won";
      };
      const outcomes = await Promise.all(["d1", "d2", "d3", "d4", "d5", "d6"].map(redeem));
      expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
      expect(await stores.devices.list("a")).toHaveLength(1);
    });
  });
}
