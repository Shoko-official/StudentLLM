// Strict request validation for the auth and account routes. Every failure is `invalid_request` with a fixed,
// value-free message: the message never echoes what the client sent.

import { ApiError } from "../../http/envelope";

export type Field =
  | { kind: "string"; min?: number; max?: number; pattern?: RegExp; oneOf?: readonly string[]; optional?: boolean }
  | { kind: "boolean"; optional?: boolean }
  | { kind: "integer"; min?: number; optional?: boolean }
  | { kind: "stringArray"; oneOf: readonly string[]; unique?: boolean; optional?: boolean };

export type Shape = Record<string, Field>;

type Out<F extends Field> = F extends { kind: "string" }
  ? string
  : F extends { kind: "boolean" }
    ? boolean
    : F extends { kind: "integer" }
      ? number
      : string[];

export type Parsed<S extends Shape> = { [K in keyof S as S[K]["optional"] extends true ? never : K]: Out<S[K]> } & {
  [K in keyof S as S[K]["optional"] extends true ? K : never]?: Out<S[K]>;
};

export function invalid(message = "The request is invalid."): ApiError {
  return new ApiError("invalid_request", { message });
}

function check(name: string, field: Field, value: unknown): unknown {
  switch (field.kind) {
    case "string": {
      if (typeof value !== "string") throw invalid(`Field "${name}" must be a string.`);
      if (field.min !== undefined && value.length < field.min) throw invalid(`Field "${name}" is too short.`);
      if (field.max !== undefined && value.length > field.max) throw invalid(`Field "${name}" is too long.`);
      if (field.pattern && !field.pattern.test(value)) throw invalid(`Field "${name}" has an invalid format.`);
      if (field.oneOf && !field.oneOf.includes(value)) throw invalid(`Field "${name}" has an unsupported value.`);
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") throw invalid(`Field "${name}" must be a boolean.`);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(`Field "${name}" must be an integer.`);
      if (field.min !== undefined && value < field.min) throw invalid(`Field "${name}" is too small.`);
      return value;
    case "stringArray": {
      if (!Array.isArray(value) || value.length > 16) throw invalid(`Field "${name}" must be an array.`);
      for (const item of value) {
        if (typeof item !== "string" || !field.oneOf.includes(item)) throw invalid(`Field "${name}" has an unsupported value.`);
      }
      if (field.unique && new Set(value).size !== value.length) throw invalid(`Field "${name}" must not repeat values.`);
      return value;
    }
  }
}

/**
 * Parses a JSON body against a shape: it must be an object, unknown fields are rejected (the contract's
 * `additionalProperties: false`), required fields must be present, and each value must fit its field.
 */
export function parseShape<S extends Shape>(value: unknown, shape: S): Parsed<S> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("The body must be a JSON object.");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(shape, key)) throw invalid("The body has an unknown field.");
  }
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape)) {
    const present = Object.hasOwn(obj, name) && obj[name] !== undefined;
    if (!present) {
      if (field.optional) continue;
      throw invalid(`Field "${name}" is required.`);
    }
    out[name] = check(name, field, obj[name]);
  }
  return out as Parsed<S>;
}

/** Parses the query string of a GET route the same way (every value is a string; a repeated parameter is refused). */
export function parseQuery<S extends Shape>(url: URL, shape: S, allowed: readonly string[] = []): Parsed<S> {
  const seen = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) throw invalid("A query parameter is repeated.");
    if (!Object.hasOwn(shape, key) && !allowed.includes(key)) throw invalid("The request has an unknown parameter.");
    seen.set(key, value);
  }
  const obj: Record<string, unknown> = {};
  for (const [key, value] of seen) obj[key] = value;
  return parseShape(obj, shape);
}

export const BASE64URL_43_128 = /^[A-Za-z0-9_-]{43,128}$/;
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
