import { describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  constantTimeEqualHex,
  hexEncode,
  hmacSha256Hex,
  keyedHashAtEpoch,
  randomBytes,
  randomToken,
  rotatingKeyedHash,
  rotatingKeyedHashes,
  saltEpoch,
  sha256Base64Url,
  sha256Hex,
  utf8Encode,
  verifyHmacSha256,
  hmacSha256,
} from "./index";

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (let len = 0; len < 40; len++) {
      const bytes = randomBytes(len || 1).subarray(0, len);
      const text = base64urlEncode(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(base64urlDecode(text))).toEqual(Array.from(bytes));
    }
  });

  it("uses the URL-safe alphabet", () => {
    expect(base64urlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
  });

  it("rejects padding, the standard alphabet and impossible lengths", () => {
    expect(() => base64urlDecode("ab==")).toThrow(RangeError);
    expect(() => base64urlDecode("a+b/")).toThrow(RangeError);
    expect(() => base64urlDecode("abcde")).toThrow(RangeError);
  });
});

describe("sha256 and hmac", () => {
  it("matches the known SHA-256 vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  it("matches RFC 4231 test case 2", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("verifies tags and rejects a changed message or key", async () => {
    const tag = await hmacSha256("key", "message");
    expect(await verifyHmacSha256("key", "message", tag)).toBe(true);
    expect(await verifyHmacSha256("key", "message!", tag)).toBe(false);
    expect(await verifyHmacSha256("other", "message", tag)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("compares strings and bytes", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secreT")).toBe(false);
    expect(constantTimeEqual(utf8Encode("a"), "a")).toBe(true);
  });

  it("handles length differences and empty inputs", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("a", "")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual(new Uint8Array([0]), new Uint8Array([]))).toBe(false);
  });

  it("compares hex digests case-insensitively", () => {
    expect(constantTimeEqualHex("ABCDEF", "abcdef")).toBe(true);
    expect(constantTimeEqualHex("abcdef", "abcde0")).toBe(false);
    expect(hexEncode(new Uint8Array([0, 255]))).toBe("00ff");
  });
});

describe("randomToken", () => {
  it("adds the prefix and carries 256 bits by default", () => {
    const token = randomToken("mt_");
    expect(token.startsWith("mt_")).toBe(true);
    expect(base64urlDecode(token.slice(3))).toHaveLength(32);
    expect(randomToken("mt_")).not.toBe(token);
  });

  it("rejects a bad prefix and a weak size", () => {
    expect(() => randomToken("MT")).toThrow(RangeError);
    expect(() => randomToken("mt_", 8)).toThrow(RangeError);
    expect(() => randomBytes(0)).toThrow(RangeError);
  });
});

describe("keyed hash with a rotating salt", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("is stable inside an epoch and changes after the rotation", async () => {
    const a = await rotatingKeyedHash("master", "email", "a@example.invalid", 10 * DAY + 5);
    const b = await rotatingKeyedHash("master", "email", "a@example.invalid", 10 * DAY + DAY - 1);
    const c = await rotatingKeyedHash("master", "email", "a@example.invalid", 11 * DAY);
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(c.epoch).toBe(a.epoch + 1);
  });

  it("separates purposes, values and master keys, and never contains the input", async () => {
    const base = await keyedHashAtEpoch("master", "email", "x", 1);
    expect(await keyedHashAtEpoch("master", "conn", "x", 1)).not.toBe(base);
    expect(await keyedHashAtEpoch("master", "email", "y", 1)).not.toBe(base);
    expect(await keyedHashAtEpoch("master2", "email", "x", 1)).not.toBe(base);
    expect(base).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("offers the previous hash for lookups right after a rotation", async () => {
    const before = await rotatingKeyedHash("master", "conn", "10.0.0.1", 3 * DAY + 1);
    const after = await rotatingKeyedHashes("master", "conn", "10.0.0.1", 4 * DAY + 1);
    expect(after.previous.hash).toBe(before.hash);
    expect(after.current.hash).not.toBe(before.hash);
  });

  it("supports a custom rotation period and rejects odd purposes", async () => {
    expect(saltEpoch(1000, 100)).toBe(10);
    await expect(keyedHashAtEpoch("m", "Bad Purpose", "x", 0)).rejects.toThrow(RangeError);
  });
});
