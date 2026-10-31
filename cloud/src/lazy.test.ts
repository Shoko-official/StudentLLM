import { describe, expect, it } from "vitest";
import { lazy } from "./lazy";

describe("lazy", () => {
  it("runs the initializer once and shares the promise between concurrent callers", async () => {
    let calls = 0;
    const get = lazy(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { key: "k" };
    });
    const [a, b, c] = await Promise.all([get(), get(), get()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(await get()).toBe(a);
    expect(calls).toBe(1);
  });

  it("does not cache a failure: the next call retries", async () => {
    let calls = 0;
    const get = lazy(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return "ok";
    });
    await expect(get()).rejects.toThrow("transient");
    await expect(get()).resolves.toBe("ok");
    await expect(get()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
