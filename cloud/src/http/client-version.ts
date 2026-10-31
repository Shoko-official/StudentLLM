import type { ClientInfo, Step } from "./context";
import { ApiError } from "./envelope";

export const CLIENT_NAME = "studentllm-desktop";
const CLIENT_HEADER = /^studentllm-desktop\/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseClientHeader(value: string | null): (ClientInfo & { parsed: ParsedVersion }) | null {
  if (value === null) return null;
  const m = CLIENT_HEADER.exec(value.trim());
  if (!m) return null;
  const parsed: ParsedVersion = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
  return { name: CLIENT_NAME, version: value.trim().slice(CLIENT_NAME.length + 1), parsed };
}

export function parseVersion(version: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null } : null;
}

/** Negative when a < b. A prerelease sorts below its release; prereleases compare as plain strings. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Client-version handshake, the first check of the header-only order. A missing or malformed
 * `X-StudentLLM-Client` is `invalid_request` (the contract does not say; see cloud/README.md). A version
 * below the minimum is `client_outdated` (426) with `X-StudentLLM-Min-Client`.
 */
export const clientVersionStep: Step = (ctx) => {
  if (!ctx.meta.client) return;
  const client = parseClientHeader(ctx.request.headers.get("X-StudentLLM-Client"));
  if (!client) {
    throw new ApiError("invalid_request", { message: "Missing or malformed X-StudentLLM-Client header." });
  }
  const min = parseVersion(ctx.deps.config.minClientVersion);
  if (min && compareVersions(client.parsed, min) < 0) {
    throw new ApiError("client_outdated", {
      headers: { "X-StudentLLM-Min-Client": ctx.deps.config.minClientVersion },
      details: { min_client_version: ctx.deps.config.minClientVersion },
    });
  }
  ctx.client = { name: client.name, version: client.version };
};
