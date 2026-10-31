import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { routeMeta } from "../http/context";
import { makeTestApp } from "../testing";
import * as account from "./account";
import * as auth from "./auth";
import * as billing from "./billing";
import * as inference from "./inference";
import * as ops from "./ops";

// A module extends the per-request scratch space by declaration merging, without touching a shared file.
declare module "../http/context" {
  interface RequestLocals {
    exampleValue?: number;
  }
}

const MODULES = { auth, account, inference, billing, ops } as const;

describe("module layout", () => {
  it("gives every module the same five exports and nothing a neighbor could collide with", () => {
    for (const [name, mod] of Object.entries(MODULES)) {
      const cap = name[0]!.toUpperCase() + name.slice(1);
      expect(Object.keys(mod).sort(), name).toEqual(
        [`create${cap}Deps`, `create${cap}Hooks`, `create${cap}ScheduledTasks`, `register${cap}Routes`].sort(),
      );
    }
  });

  it("declares secrets, vars and limits in a config.ts per module", async () => {
    for (const name of Object.keys(MODULES)) {
      const config = await import(`./${name}/config.ts`);
      expect(Object.keys(config).sort(), name).toEqual(["limits", "secrets", "vars"]);
    }
  });
});

describe("request locals", () => {
  it("are typed through declaration merging and private to the request", async () => {
    const t = makeTestApp({ allowMissingHooks: true, hooks: { checkAuthRateLimit: (ctx) => void (ctx.locals.exampleValue = 41) } });
    let seen: number | undefined;
    t.app.router.add("GET", "/test/locals", (ctx) => ((seen = (ctx.locals.exampleValue ?? 0) + 1), new Response("ok")), routeMeta({ operationId: "locals", auth: "none" }));
    await t.request("/test/locals");
    expect(seen).toBe(42);
  });
});

describe("modules read request bodies only through ctx.body", () => {
  function sourceFiles(dir: URL): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) out.push(...sourceFiles(child));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(fileURLToPath(child));
    }
    return out;
  }

  const FORBIDDEN = /\b(?:ctx\.)?request\.(?:json|text|formData|arrayBuffer|blob|body|bodyUsed)\b/;

  it("finds no direct body read of ctx.request in src/modules", () => {
    const files = sourceFiles(new URL("./", import.meta.url));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith("//")) return;
        expect(FORBIDDEN.test(line), `${file}:${i + 1} reads the body of ctx.request; use ctx.body`).toBe(false);
      });
    }
  });

  it("is backed by a body-less ctx.request, so a slip fails at run time too", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    let bodyIsNull: boolean | undefined;
    t.app.router.add(
      "POST",
      "/test/nobody",
      (ctx) => ((bodyIsNull = ctx.request.body === null), new Response("ok")),
      routeMeta({ operationId: "nobody", auth: "none", body: { kind: "json", limit: "small" } }),
    );
    await t.request("/test/nobody", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"secret":"prompt text"}' });
    expect(bodyIsNull).toBe(true);
  });
});
