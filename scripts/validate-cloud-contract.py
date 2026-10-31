#!/usr/bin/env python3
"""Validate the planned cloud API contracts and their shared fixtures.

Two contracts are validated, with no network access:
  - the public gateway API: docs/cloud-api.openapi.yaml with docs/cloud-api-fixtures/;
  - the admin API: docs/cloud-admin.openapi.yaml with docs/cloud-admin-fixtures/.

For each contract:
  1. the OpenAPI file is a valid OpenAPI 3.1 document;
  2. every file in the fixtures directory is listed in index.json and vice versa;
  3. each fixture names a real operationId, uses a status code the operation declares,
     and its request body, response body and SSE event payloads satisfy the JSON Schemas
     of the contract (JSON Schema 2020-12, with format checking enabled);
  4. error fixtures use a code from the ErrorCode enum and never carry a secret in the envelope.

For the admin contract only, additional rules keep the design and the contract aligned:
  5. surface separation: every path is under /admin/v1, the public contract lists no admin path,
     and the two contracts use different servers;
  6. every operation declares x-required-role, and every state-changing operation has the CSRF header,
     an Idempotency-Key and a mandatory reason (except the single-use invitation accept and the
     read-only POST routes marked x-read-only);
  7. admin management routes are owner only; single-account reads declare an audit action, and every
     declared audit action exists in the AuditAction enum;
  8. no schema has a property that could carry content, an IP address, a user agent or a token, and the
     few secret-bearing fields exist only in their one named schema;
  9. fixtures use the admin credential (never a bearer token), the CSRF header and an Idempotency-Key
     where the operation requires them, and their method and path match the operation.

Usage:
  python scripts/validate-cloud-contract.py
Requires: pyyaml, jsonschema, openapi-spec-validator, rfc3339-validator (see requirements-cloud-contract.txt).
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_SPEC = ROOT / "docs" / "cloud-api.openapi.yaml"
PUBLIC_FIXTURES = ROOT / "docs" / "cloud-api-fixtures"
ADMIN_SPEC = ROOT / "docs" / "cloud-admin.openapi.yaml"
ADMIN_FIXTURES = ROOT / "docs" / "cloud-admin-fixtures"
SECRET_KEYS = {
    "manage_token", "refresh_token", "access_token", "code", "code_verifier",
    "csrf_token", "invitation_code", "idempotency_key", "reauth_url",
}

ADMIN_ROLES = {"support", "admin", "owner", "invitee"}
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
# Property names that must never exist in the admin contract: content, network identifiers, credentials.
ADMIN_FORBIDDEN_PROPERTIES = {
    "content", "prompt", "completion", "answer", "transcript", "messages", "ip", "ip_address",
    "user_agent", "refresh_token", "access_token", "manage_token", "password", "api_key", "secret",
}
# Secret-bearing properties allowed in exactly one schema.
ADMIN_SINGLE_HOME_PROPERTIES = {
    "invitation_code": {"InvitationAcceptRequest"},
    "csrf_token": {"AdminSession"},
}
ADMIN_SINGLE_ACCOUNT_READ_AUDIT_PATHS = {"/admin/v1/grants/{grant_id}"}

errors = []
# Format assertions (date-time, uuid, ...) are enforced; date-time needs rfc3339-validator.
FORMAT_CHECKER = FormatChecker()


def fail(message):
    errors.append(message)
    print("FAIL", message)


def schema_for(components, name):
    return Draft202012Validator({"$ref": "#/components/schemas/" + name, "components": components}, format_checker=FORMAT_CHECKER)


def check(validator, instance, label):
    for e in validator.iter_errors(instance):
        path = "/".join(str(p) for p in e.absolute_path)
        fail(f"{label}: {path or '<root>'}: {e.message}")


def resolve(components, node):
    """Follow a local $ref to a component schema, one level."""
    if isinstance(node, dict) and "$ref" in node:
        return components["schemas"][node["$ref"].split("/")[-1]]
    return node


def iter_operations(spec):
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if method in HTTP_METHODS and isinstance(op, dict):
                yield path, method, op


def param_names(spec, op):
    names = set()
    for p in op.get("parameters", []):
        if "$ref" in p:
            p = spec["components"]["parameters"][p["$ref"].split("/")[-1]]
        names.add(p["name"])
    return names


def body_schema(spec, op):
    content = op.get("requestBody", {}).get("content", {}).get("application/json", {})
    return resolve(spec["components"], content.get("schema", {}))


def lint_admin_spec(spec, public_spec):
    """Rules that keep the admin design and the admin contract aligned (see docs/cloud-admin.md)."""
    components = spec["components"]
    audit_actions = set(components["schemas"]["AuditAction"]["enum"])

    # 5. surface separation
    for path, _, _ in iter_operations(spec):
        if not path.startswith("/admin/v1/"):
            fail(f"admin spec: path {path} is outside /admin/v1")
    for path, _, _ in iter_operations(public_spec):
        if "admin" in path.lower():
            fail(f"public spec: path {path} must not expose an admin route")
    admin_servers = {s["url"] for s in spec.get("servers", [])}
    public_servers = {s["url"] for s in public_spec.get("servers", [])}
    if admin_servers & public_servers:
        fail("admin spec and public spec must use different servers")
    if "bearerAuth" in spec["components"].get("securitySchemes", {}) or "manageToken" in spec["components"].get("securitySchemes", {}):
        fail("admin spec must not accept a public bearer or manage token")

    seen_ids = set()
    for path, method, op in iter_operations(spec):
        op_id = op.get("operationId", f"{method} {path}")
        if op_id in seen_ids:
            fail(f"admin spec: duplicate operationId {op_id}")
        seen_ids.add(op_id)

        # 6. roles, CSRF, idempotency, reason
        role = op.get("x-required-role")
        if role not in ADMIN_ROLES:
            fail(f"{op_id}: x-required-role must be one of {sorted(ADMIN_ROLES)}")
        statuses = set(op.get("responses", {}))
        for needed in ("401", "403"):
            if needed not in statuses:
                fail(f"{op_id}: must declare a {needed} response")
        names = param_names(spec, op)
        mutating = method != "get"
        if mutating:
            if "X-StudentLLM-Admin-CSRF" not in names:
                fail(f"{op_id}: state-changing route without the CSRF header")
            if not op.get("x-read-only") and role != "invitee":
                if "Idempotency-Key" not in names:
                    fail(f"{op_id}: state-changing route without an Idempotency-Key")
                if "reason" not in body_schema(spec, op).get("required", []):
                    fail(f"{op_id}: state-changing route without a mandatory reason")
                if not op.get("x-audit-action"):
                    fail(f"{op_id}: state-changing route without x-audit-action")
        elif "Idempotency-Key" in names:
            fail(f"{op_id}: a GET route must not take an Idempotency-Key")

        # 7. owner-only admin management, audited single-account reads, known audit actions
        if (path.startswith("/admin/v1/admins") or path.startswith("/admin/v1/invitations")) and role not in ("owner", "invitee"):
            fail(f"{op_id}: admin management routes are owner only")
        if "/admin/v1/accounts/{account_id}" in path and method == "get" and not op.get("x-audit-action"):
            fail(f"{op_id}: a single-account read must declare an audit action")
        if path in ADMIN_SINGLE_ACCOUNT_READ_AUDIT_PATHS and method == "get" and not op.get("x-audit-action"):
            fail(f"{op_id}: a single-record read must declare an audit action")
        action = op.get("x-audit-action")
        if action and action not in audit_actions:
            fail(f"{op_id}: x-audit-action {action} is not in the AuditAction enum")
        if op.get("x-destructive") and role == "support":
            fail(f"{op_id}: a destructive route cannot be open to support")

    # 8. forbidden and single-home properties
    for name, schema in components["schemas"].items():
        for prop in (schema.get("properties") or {}):
            if prop in ADMIN_FORBIDDEN_PROPERTIES:
                fail(f"schema {name}: forbidden property {prop}")
            homes = ADMIN_SINGLE_HOME_PROPERTIES.get(prop)
            if homes is not None and name not in homes:
                fail(f"schema {name}: property {prop} is allowed only in {sorted(homes)}")
    audit_props = set(components["schemas"]["AuditRow"]["properties"])
    for banned in ("ip", "ip_address", "user_agent", "email", "token", "content"):
        if banned in audit_props:
            fail(f"AuditRow must not have a {banned} property")


def audit_row_hash(row):
    """row_hash = SHA-256 over prev_hash, a newline, and the canonical JSON of the row without row_hash.

    Canonical JSON: keys sorted, no whitespace, UTF-8 (docs/cloud-admin.md, "Audit log").
    """
    body = {k: v for k, v in row.items() if k != "row_hash"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((row["prev_hash"] + "\n" + canonical).encode("utf-8")).hexdigest()


def verify_audit_chain(rows, label):
    """Recompute every row hash and check that consecutive rows are linked (rows are newest first)."""
    ordered = sorted(rows, key=lambda r: r["seq"])
    for i, row in enumerate(ordered):
        if audit_row_hash(row) != row["row_hash"]:
            fail(f"{label}: audit row seq {row['seq']} does not match its row_hash")
        if i > 0 and ordered[i - 1]["seq"] + 1 == row["seq"] and ordered[i - 1]["row_hash"] != row["prev_hash"]:
            fail(f"{label}: audit row seq {row['seq']} is not linked to the previous row")


def path_matches(template, path):
    pattern = "/".join("[^/]+" if seg.startswith("{") else re.escape(seg) for seg in template.split("/"))
    return re.fullmatch(pattern, path.split("?")[0]) is not None


def lint_admin_fixture(spec, label, fx, path_to_ops):
    req = fx["request"]
    headers = {k.lower(): v for k, v in req.get("headers", {}).items()}
    method = req["method"].lower()
    op = next((o for p, m, o in iter_operations(spec) if o.get("operationId") == fx["operation"]), None)
    if "authorization" in headers:
        fail(f"{label}: an admin request must not carry an Authorization bearer header")
    if "cf-access-jwt-assertion" not in headers:
        fail(f"{label}: an admin request must carry Cf-Access-Jwt-Assertion")
    template = next((p for p, m, o in iter_operations(spec) if o is op), None)
    if template is None or not path_matches(template, req["path"]) or path_to_ops[template][method] is not op:
        fail(f"{label}: method or path does not match operation {fx['operation']}")
    if method != "get":
        if "x-studentllm-admin-csrf" not in headers:
            fail(f"{label}: a POST needs the CSRF header")
        if not op.get("x-read-only") and op.get("x-required-role") != "invitee" and "idempotency-key" not in headers:
            fail(f"{label}: a state-changing request needs an Idempotency-Key")
    if re.search(r"\b[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9.-]+\.[a-z]{2,}\b", json.dumps(fx)):
        fail(f"{label}: fixtures must only use example.invalid addresses")


def validate_contract(name, spec_path, fixtures_dir, admin_spec_check=None, public_spec=None):
    print(f"== {name} ==")
    spec = yaml.safe_load(spec_path.read_text(encoding="utf-8"))
    try:
        validate_openapi(spec)
    except Exception as exc:  # the library raises several error types
        fail(f"{name}: OpenAPI document is invalid: {exc}")
        return None
    print("OpenAPI document is valid")

    components = spec["components"]
    error_codes = set(components["schemas"]["ErrorCode"]["enum"])
    operations = {}
    path_to_ops = {}
    for path, method, op in iter_operations(spec):
        path_to_ops.setdefault(path, {})[method] = op
        if "operationId" in op:
            operations[op["operationId"]] = op

    if admin_spec_check is not None:
        admin_spec_check(spec, public_spec)

    index = json.loads((fixtures_dir / "index.json").read_text(encoding="utf-8"))
    listed = set(index["fixtures"])
    present = {p.name for p in fixtures_dir.glob("*.json") if p.name != "index.json"}
    for fname in sorted(listed - present):
        fail(f"index.json lists a missing file: {fname}")
    for fname in sorted(present - listed):
        fail(f"fixture not listed in index.json: {fname}")

    for fname in sorted(listed & present):
        fx = json.loads((fixtures_dir / fname).read_text(encoding="utf-8"))
        label = fname
        op = operations.get(fx["operation"])
        if op is None:
            fail(f"{label}: unknown operation {fx['operation']}")
            continue
        status = str(fx["response"]["status"])
        if status not in op["responses"]:
            fail(f"{label}: status {status} is not declared by {fx['operation']}")
        if admin_spec_check is not None:
            lint_admin_fixture(spec, label, fx, path_to_ops)

        body_in = fx["request"].get("body")
        content = op.get("requestBody", {}).get("content", {})
        if body_in is not None:
            ref = content.get("application/json", {}).get("schema", {}).get("$ref")
            if ref is None:
                fail(f"{label}: request has a JSON body but the operation declares none")
            else:
                check(schema_for(components, ref.split("/")[-1]), body_in, label + " request")
        multipart = fx["request"].get("multipart")
        if multipart is not None:
            ref = content.get("multipart/form-data", {}).get("schema", {}).get("$ref")
            if ref is None:
                fail(f"{label}: multipart request but the operation declares none")
            else:
                fields = dict(multipart)
                fields["file"] = "x"  # binary content is not represented in the fixture
                check(schema_for(components, ref.split("/")[-1]), fields, label + " multipart request")

        resp = fx["response"]
        schema_name = fx.get("response_schema")
        if "sse" in resp:
            lines = resp["sse"]
            event, saw_done, saw_error = None, False, False
            for line in lines:
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        saw_done = True
                    elif event in fx.get("sse_event_schemas", {}):
                        payload = json.loads(data)
                        check(schema_for(components, fx["sse_event_schemas"][event]), payload, f"{label} {event} event")
                        if event == "error":
                            saw_error = True
                            if payload["error"]["code"] not in error_codes:
                                fail(f"{label}: unknown error code in SSE")
                    else:
                        json.loads(data)  # plain chunks must be JSON
                elif line == "":
                    event = None
            if saw_error and saw_done:
                fail(f"{label}: an SSE stream with an error event must not end with [DONE]")
            if not saw_error and not saw_done:
                fail(f"{label}: a successful SSE stream must end with [DONE]")
            continue

        if schema_name is None:
            if resp.get("body") is not None:
                fail(f"{label}: response has a body but no response_schema")
            continue
        body = resp.get("body")
        check(schema_for(components, schema_name), body, label + " response")
        if schema_name == "AuditList":
            verify_audit_chain(body["data"], label)
        if schema_name == "Error":
            err = body["error"]
            if err["code"] not in error_codes:
                fail(f"{label}: unknown error code {err['code']}")
            for key in (err.get("details") or {}):
                if key in SECRET_KEYS:
                    fail(f"{label}: secret-bearing key {key} in error.details")

    print(f"{len(listed & present)} fixtures checked")
    return spec


def main():
    public_spec = validate_contract("public cloud API", PUBLIC_SPEC, PUBLIC_FIXTURES)
    if public_spec is None:
        return
    validate_contract("admin API", ADMIN_SPEC, ADMIN_FIXTURES, admin_spec_check=lint_admin_spec, public_spec=public_spec)


if __name__ == "__main__":
    main()
    if errors:
        print(f"{len(errors)} problem(s)")
        sys.exit(1)
    print("OK")
