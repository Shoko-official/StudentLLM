import { describe, expect, it } from "vitest";
import { makeAuthApp, pkcePair, type AuthHarness } from "../../testing/auth-app";
import { normalizeConnection } from "./connection";

describe("normalizeConnection", () => {
  it("keeps IPv4 as it is", () => {
    expect(normalizeConnection("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeConnection(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("collapses IPv6 to its /64, however it is written", () => {
    const a = normalizeConnection("2001:db8:1:2::1");
    expect(a).toBe("v6:2001:db8:1:2");
    expect(normalizeConnection("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(a);
    expect(normalizeConnection("2001:db8:1:2:3:4:5:6")).toBe(a);
    expect(normalizeConnection("[2001:db8:1:2::9]")).toBe(a);
    expect(normalizeConnection("2001:db8:1:2::9%eth0")).toBe(a);
    expect(normalizeConnection("2001:db8:1:3::1")).not.toBe(a);
    expect(normalizeConnection("2001:db8::1")).toBe("v6:2001:db8:0:0");
    expect(normalizeConnection("::1")).toBe("v6:0:0:0:0");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(normalizeConnection("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeConnection("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("fails safe to the shared unknown bucket for anything that is not an address", () => {
    for (const bad of [undefined, null, "", "   ", "garbage", "999.1.1.1", "1.2.3", "2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "12345::1", "1.2.3.4, 5.6.7.8"]) {
      expect(normalizeConnection(bad), String(bad)).toBe("unknown");
    }
  });
});

describe("the connection windows", () => {
  const logout = (t: AuthHarness, ip?: string) =>
    t.app.handle(
      new Request("https://api.example.invalid/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ip === undefined ? {} : { "CF-Connecting-IP": ip }) },
        body: JSON.stringify({ refresh_token: "rt_unknown" }),
      }),
    );
  const statuses = async (t: AuthHarness, count: number, ip?: string) => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push((await logout(t, ip)).status);
    return out;
  };

  it("give every address of one IPv6 /64 the same window, and another /64 its own", async () => {
    const t = await makeAuthApp();
    // 60 requests from varying addresses of one /64 use up the one shared window ...
    for (let i = 0; i < 60; i++) expect((await logout(t, `2001:db8:1:2::${i + 1}`)).status).toBe(204);
    expect((await logout(t, "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(429);
    // ... another /64 is untouched.
    expect((await logout(t, "2001:db8:1:3::1")).status).toBe(204);
  });

  it("fail safe without the header: one stricter shared bucket, however the header is missing or broken", async () => {
    const t = await makeAuthApp();
    const first = await statuses(t, 10);
    expect(first.every((s) => s === 204)).toBe(true);
    // The 11th is refused, from a request with no header or with a header nobody can read.
    expect((await logout(t)).status).toBe(429);
    expect((await logout(t, "garbage")).status).toBe(429);
    expect((await logout(t, "")).status).toBe(429);
    // A known connection is not affected, and has the larger allowance.
    expect(await statuses(t, 30, "203.0.113.9")).toEqual(Array(30).fill(204));
  });

  it("apply the stricter email limits to the unknown bucket too", async () => {
    const t = await makeAuthApp();
    const ask = async (i: number) =>
      t.app.handle(
        new Request("https://api.example.invalid/auth/email/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: `user${i}@example.invalid`, code_challenge: (await pkcePair()).challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion }),
        }),
      );
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push((await ask(i)).status);
    expect(out).toEqual([202, 202, 202, 202, 202, 429]);
  });
});
