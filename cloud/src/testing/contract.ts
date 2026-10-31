// Test-only: loads the merged contract (docs/cloud-api.openapi.yaml) and validates values against its
// JSON Schemas with a small validator that covers the subset the contract uses. Node-only (node:fs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SPEC_PATH = `${REPO_ROOT}docs/cloud-api.openapi.yaml`;
export const API_DOC_PATH = `${REPO_ROOT}docs/cloud-api.md`;
export const FIXTURES_DIR = `${REPO_ROOT}docs/cloud-api-fixtures/`;

// The contract is untyped JSON; the validator walks it dynamically.
type Json = Record<string, any>;

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  def: Json;
}

export interface Contract {
  spec: Json;
  operations: Operation[];
  errorCodes: string[];
}

let cached: Contract | undefined;

export function loadContract(): Contract {
  if (cached) return cached;
  const spec = parse(readFileSync(SPEC_PATH, "utf8")) as Json;
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries<Json>(spec.paths)) {
    for (const [method, def] of Object.entries<Json>(item)) {
      if (def && typeof def === "object" && def.operationId) {
        operations.push({ operationId: def.operationId, method: method.toUpperCase(), path, def });
      }
    }
  }
  cached = { spec, operations, errorCodes: spec.components.schemas.ErrorCode.enum };
  return cached;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  return type === actual;
}

/**
 * Validates `value` against a schema of the contract. Returns a list of problems (empty when valid).
 * Supported: $ref, oneOf, const, enum, type (and type arrays), properties, required,
 * additionalProperties (false, true or a schema), items, minItems, maxItems, uniqueItems, minLength,
 * maxLength, pattern, minimum, maximum, and the formats date-time and uuid.
 */
export function validateSchema(schema: unknown, value: unknown, contract: Contract = loadContract(), path = "$"): string[] {
  if (schema === true || schema === undefined) return [];
  const s = schema as Json;
  if (s.$ref) {
    const target = (s.$ref as string).split("/").reduce<any>((node, key) => (key === "#" ? contract.spec : node?.[key]), undefined);
    if (!target) return [`${path}: unresolved ${s.$ref}`];
    return validateSchema(target, value, contract, path);
  }
  const problems: string[] = [];
  if (s.oneOf) {
    const matching = (s.oneOf as unknown[]).filter((sub) => validateSchema(sub, value, contract, path).length === 0);
    if (matching.length !== 1) problems.push(`${path}: matches ${matching.length} of ${s.oneOf.length} oneOf branches`);
    return problems;
  }
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) problems.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !(s.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    problems.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchesType(t, value))) {
      problems.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return problems;
    }
  }

  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) problems.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) problems.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) problems.push(`${path}: does not match ${s.pattern}`);
    if (s.format === "date-time" && !DATE_TIME.test(value)) problems.push(`${path}: not an RFC 3339 date-time`);
    if (s.format === "uuid" && !UUID.test(value)) problems.push(`${path}: not a UUID`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) problems.push(`${path}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) problems.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) problems.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) problems.push(`${path}: more than ${s.maxItems} items`);
    if (s.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) problems.push(`${path}: items are not unique`);
    value.forEach((item, i) => problems.push(...validateSchema(s.items, item, contract, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Json;
    for (const name of (s.required ?? []) as string[]) {
      if (!(name in obj)) problems.push(`${path}: missing required "${name}"`);
    }
    for (const [key, val] of Object.entries(obj)) {
      if (key in props) problems.push(...validateSchema(props[key], val, contract, `${path}.${key}`));
      else if (s.additionalProperties === false) problems.push(`${path}: unexpected property "${key}"`);
      else if (typeof s.additionalProperties === "object") problems.push(...validateSchema(s.additionalProperties, val, contract, `${path}.${key}`));
    }
  }
  return problems;
}

/** Validates against `components.schemas[name]`. */
export function validateAgainst(name: string, value: unknown, contract: Contract = loadContract()): string[] {
  const schema = contract.spec.components.schemas[name];
  if (!schema) return [`unknown schema ${name}`];
  return validateSchema(schema, value, contract);
}
