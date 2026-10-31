#!/usr/bin/env python3
"""Validate the planned cloud API contracts and their shared fixtures.

Two contracts are validated, with no network access:
  - the public gateway API: docs/cloud-api.openapi.yaml with docs/cloud-api-fixtures/;
  - the admin API: docs/cloud-admin.openapi.yaml with docs/cloud-admin-fixtures/ and docs/cloud-admin.md.

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
  6. extension flags are normalised (x-required-role, x-phase, x-read-only, x-requires-stepup,
     x-allowed-when-frozen, x-csrf-exempt, x-destructive, x-notifies-owner, x-audit-action,
     x-audit-independent), phases are first or later, and the later-phase routes are exactly the
     invitation, admin management and blocklist routes;
  7. every state-changing operation has the session/CSRF header (only createAdminSession and
     acceptInvitation are exempt), an Idempotency-Key, a mandatory reason, an audit action and an explicit
     freeze flag; destructive implies owner notification; step-up operations declare the step-up header;
     containment writes (allowed while frozen) are owner plus step-up; every audited operation declares 503
     (except the audit-independent freeze and unfreeze); every GET except the two session reads is audited;
     the user cannot switch off the notification of a cancellation, suspension or deletion;
  8. the operation matrix in docs/cloud-admin.md (role, step-up, freeze, phase, owner email, audit action)
     equals the extension flags of the contract, and so does its list of operations allowed while frozen;
  9. a recursive walk of every schema (nested and inline) finds no property that could carry content, an
     IP address, a user agent or a token, secret-bearing fields exist only in their one named schema, the
     audit row has no network or content field, and every per-action audit params schema is closed
     (additionalProperties false) with bounded strings, and covers every audit action exactly once;
 10. fixtures use the Access header and never a bearer token, carry the session header where required, an
     Idempotency-Key only where the operation takes one, and a step-up header on step-up operations, and use
     only example.invalid addresses;
 11. the audit chains in the fixtures are recomputed: the unkeyed content chain, the HMAC row hashes under a
     fixture key, links between rows, both genesis hashes, and contiguity for exports (a gap must fail);
 12. negative fixtures (docs/cloud-admin-fixtures/negative/) must FAIL validation with exactly the stated message;
 13. the contract ceilings in the design document equal the schema maxima, owner-only values name real request
     fields, and fixtures contain no IP address or spelled-out email address (the linter cannot detect names or
     other free personal data in a reason: that stays the admin's responsibility and the UI warning).

Usage:
  python scripts/validate-cloud-contract.py
Requires: pyyaml, jsonschema, openapi-spec-validator, rfc3339-validator (see requirements-cloud-contract.txt).
"""
import hashlib
import hmac
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
ADMIN_DOC = ROOT / "docs" / "cloud-admin.md"
SECRET_KEYS = {
    "manage_token", "refresh_token", "access_token", "code", "code_verifier",
    "csrf_token", "invitation_code", "idempotency_key", "enrollment_ticket",
}

ADMIN_ROLES = {"support", "admin", "owner", "invitee"}
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
LATER_PREFIXES = ("/admin/v1/invitations", "/admin/v1/admins", "/admin/v1/blocklist")
# Property names that must never exist in the admin contract: content, network identifiers, credentials.
ADMIN_FORBIDDEN_PROPERTIES = {
    "content", "prompt", "completion", "answer", "transcript", "messages", "ip", "ip_address",
    "user_agent", "refresh_token", "access_token", "manage_token", "password", "api_key", "secret",
    "email_hash", "body",
}
# Secret-bearing properties allowed in exactly one schema.
ADMIN_SINGLE_HOME_PROPERTIES = {
    "invitation_code": {"InvitationAcceptRequest"},
    "csrf_token": {"AdminSessionCreated"},
    "enrollment_ticket": {"CredentialRegistrationStart"},
}
CSRF_EXEMPT_ALLOWED = {"createAdminSession", "acceptInvitation"}
NO_USER_SWITCH_SCHEMAS = {"CancelRequest", "SuspendRequest", "DeletionRequest"}  # user is always notified
NO_AUDIT_GETS = {"getAdminSession", "getSystemState"}
FREEZE_EXEMPT_FROM_CONTAINMENT_RULE = {"freezeAdminWrites", "verifyAuditChain"}
BOOLEAN_FLAGS = ("x-read-only", "x-requires-stepup", "x-destructive", "x-notifies-owner", "x-csrf-exempt",
                 "x-allowed-when-frozen", "x-audit-independent")
# Test-only key and environment for the audit chain in the fixtures. Not a secret.
FIXTURE_CHAIN_KEY = b"studentllm-fixture-chain-key-not-a-secret"
FIXTURE_ENVIRONMENT = "fixture"
AUDIT_NOT_HMACED = {"row_hash", "reason_text", "reason_state"}
AUDIT_NOT_CONTENT = {"row_hash", "content_sha256", "reason_text", "reason_state"}
CEILING_FIELDS = {
    "days": ("GrantCreateRequest", "days"),
    "budget_percent": ("GrantCreateRequest", "budget_percent"),
    "grant_max_total_percent": ("AdminLimits", "grant_max_total_percent"),
    "grant_max_days_per_account_per_year": ("AdminLimits", "grant_max_days_per_account_per_year"),
    "grant_max_per_admin_per_day": ("AdminLimits", "grant_max_per_admin_per_day"),
    "suspension_max_days": ("AdminLimits", "suspension_max_days"),
    "deletion_max_cooling_off_hours": ("AdminLimits", "deletion_max_cooling_off_hours"),
}
IPV4 = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
SPELLED_EMAIL = re.compile(r"\b[\w.]+\s*(?:\(at\)|\[at\]|\bat\b)\s*[\w.-]+\s*(?:\(dot\)|\[dot\]|\bdot\b)\s*\w+\b", re.I)

errors = []
_capture = None  # a list while a negative fixture is being checked
# Format assertions (date-time, uuid, ...) are enforced; date-time needs rfc3339-validator.
FORMAT_CHECKER = FormatChecker()


def fail(message):
    if _capture is not None:
        _capture.append(message)
        return
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


def walk_schemas(node, root, visit):
    """Call visit(root_name, properties_dict) for every dict with a 'properties' map, at any depth."""
    if isinstance(node, dict):
        props = node.get("properties")
        if isinstance(props, dict):
            visit(root, props, node)
        for key, value in node.items():
            walk_schemas(value, root, visit)
    elif isinstance(node, list):
        for value in node:
            walk_schemas(value, root, visit)


# ---------------------------------------------------------------- audit chain
def canonical_json(obj):
    """RFC 8785 style canonical JSON. For the strings, integers, booleans and nulls used in audit rows
    (ASCII in the fixtures) this equals sorted keys, no whitespace, UTF-8."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def audit_content_hash(row):
    """content_sha256 = SHA-256 of the canonical JSON of the row without row_hash, content_sha256 and the reason text.
    It is unkeyed, so a public verifier with no secret can check content integrity up to each signed anchor."""
    body = {k: v for k, v in row.items() if k not in AUDIT_NOT_CONTENT}
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def audit_row_hash(row, key=FIXTURE_CHAIN_KEY):
    """row_hash = HMAC-SHA-256(key, prev_hash + newline + canonical JSON of the chained fields, content_sha256 included)."""
    body = {k: v for k, v in row.items() if k not in AUDIT_NOT_HMACED}
    return hmac.new(key, (row["prev_hash"] + "\n" + canonical_json(body)).encode("utf-8"), hashlib.sha256).hexdigest()


def audit_genesis_hash(key=FIXTURE_CHAIN_KEY, environment=FIXTURE_ENVIRONMENT):
    return hmac.new(key, f"studentllm-audit-genesis-v1:{environment}".encode("utf-8"), hashlib.sha256).hexdigest()


def audit_content_genesis(environment=FIXTURE_ENVIRONMENT):
    return hashlib.sha256(f"studentllm-audit-content-genesis-v1:{environment}".encode("utf-8")).hexdigest()


def verify_audit_chain(rows, label, contiguous=False):
    """Recompute the content hashes and the HMAC row hashes, check both genesis hashes and the links between rows.
    An export must be contiguous: a gap in the sequence fails."""
    ordered = sorted(rows, key=lambda r: r["seq"])
    for i, row in enumerate(ordered):
        if audit_content_hash(row) != row["content_sha256"]:
            fail(f"{label}: audit row seq {row['seq']} does not match its content_sha256")
        if audit_row_hash(row) != row["row_hash"]:
            fail(f"{label}: audit row seq {row['seq']} does not match its row_hash")
        if row["seq"] == 1 and (row["prev_hash"] != audit_genesis_hash() or row["prev_content_sha256"] != audit_content_genesis()):
            fail(f"{label}: audit row seq 1 does not start from the genesis hash")
        if i > 0:
            prev = ordered[i - 1]
            if prev["seq"] == row["seq"]:
                fail(f"{label}: duplicate audit sequence number {row['seq']}")
            elif prev["seq"] + 1 == row["seq"]:
                if prev["row_hash"] != row["prev_hash"] or prev["content_sha256"] != row["prev_content_sha256"]:
                    fail(f"{label}: audit row seq {row['seq']} is not linked to the previous row")
            elif contiguous:
                fail(f"{label}: gap in the audit sequence between {prev['seq']} and {row['seq']}")


# ------------------------------------------------------------------ admin spec
def parse_md_matrix(text):
    """Rows of the operation matrix of docs/cloud-admin.md between its markers."""
    m = re.search(r"<!-- operation-matrix:start -->(.*?)<!-- operation-matrix:end -->", text, re.S)
    rows = {}
    if not m:
        return None
    for line in m.group(1).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 8 and cells[0].startswith("`"):
            rows[cells[0].strip("`")] = cells
    return rows


def parse_md_frozen_list(text):
    m = re.search(r"<!-- frozen-list:start -->(.*?)<!-- frozen-list:end -->", text, re.S)
    if not m:
        return None
    return set(re.findall(r"^- `([A-Za-z]+)`", m.group(1), re.M))


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
    if {s["url"] for s in spec.get("servers", [])} & {s["url"] for s in public_spec.get("servers", [])}:
        fail("admin spec and public spec must use different servers")
    if {"bearerAuth", "manageToken"} & set(components.get("securitySchemes", {})):
        fail("admin spec must not accept a public bearer or manage token")

    seen_ids = set()
    frozen_ops = set()
    for path, method, op in iter_operations(spec):
        op_id = op.get("operationId", f"{method} {path}")
        if op_id in seen_ids:
            fail(f"admin spec: duplicate operationId {op_id}")
        seen_ids.add(op_id)
        mutating = method != "get"

        # 6. normalised flags and phases
        role = op.get("x-required-role")
        if role not in ADMIN_ROLES:
            fail(f"{op_id}: x-required-role must be one of {sorted(ADMIN_ROLES)}")
        phase = op.get("x-phase")
        if phase not in ("first", "later"):
            fail(f"{op_id}: x-phase must be first or later")
        if path.startswith(LATER_PREFIXES) != (phase == "later"):
            fail(f"{op_id}: only the invitation, admin management and blocklist routes are x-phase later")
        for flag in BOOLEAN_FLAGS:
            if flag in op and not isinstance(op[flag], bool):
                fail(f"{op_id}: {flag} must be a boolean")
        for flag in ("x-read-only", "x-requires-stepup", "x-destructive", "x-notifies-owner"):
            if flag not in op:
                fail(f"{op_id}: missing {flag}")
        ro = op.get("x-read-only", False)
        if not mutating and not ro:
            fail(f"{op_id}: a GET route must be x-read-only")
        statuses = set(op.get("responses", {}))
        for needed in ("401", "403"):
            if needed not in statuses:
                fail(f"{op_id}: must declare a {needed} response")
        names = param_names(spec, op)

        # 7. session header, CSRF exemption, idempotency, reason, audit, freeze flag
        exempt = op.get("x-csrf-exempt", False)
        if exempt and op_id not in CSRF_EXEMPT_ALLOWED:
            fail(f"{op_id}: x-csrf-exempt is allowed only for {sorted(CSRF_EXEMPT_ALLOWED)}")
        if op_id in CSRF_EXEMPT_ALLOWED and mutating and not exempt:
            fail(f"{op_id}: must declare x-csrf-exempt: true")
        if not exempt and "X-StudentLLM-Admin-CSRF" not in names:
            fail(f"{op_id}: missing the session/CSRF header")
        if exempt and "X-StudentLLM-Admin-CSRF" in names:
            fail(f"{op_id}: an exempt operation must not take the session/CSRF header")
        writes = mutating and not ro and role != "invitee"
        if writes:
            if "Idempotency-Key" not in names:
                fail(f"{op_id}: state-changing route without an Idempotency-Key")
            if "reason" not in body_schema(spec, op).get("required", []):
                fail(f"{op_id}: state-changing route without a mandatory reason")
            if not op.get("x-audit-action"):
                fail(f"{op_id}: state-changing route without x-audit-action")
        elif "Idempotency-Key" in names:
            fail(f"{op_id}: only state-changing routes take an Idempotency-Key")
        if mutating and "x-allowed-when-frozen" not in op:
            fail(f"{op_id}: a POST route must declare x-allowed-when-frozen explicitly")
        if mutating and op.get("x-allowed-when-frozen") and not ro:
            frozen_ops.add(op_id)
            if op_id not in FREEZE_EXEMPT_FROM_CONTAINMENT_RULE and (role != "owner" or not op.get("x-requires-stepup")):
                fail(f"{op_id}: a write allowed while frozen must be owner plus step-up")
            if op_id not in ("verifyAuditChain", "exportAuditLog") and not op.get("x-audit-independent"):
                fail(f"{op_id}: a containment write must not depend on the audit writer (x-audit-independent)")
        if op.get("x-requires-stepup"):
            if not mutating:
                fail(f"{op_id}: only POST routes can require a step-up")
            if "X-StudentLLM-Admin-StepUp" not in names and not op.get("x-stepup-alternative"):
                fail(f"{op_id}: a step-up route must declare the step-up header")
        if op.get("x-destructive"):
            if not op.get("x-notifies-owner"):
                fail(f"{op_id}: a destructive route must notify the owners")
            if role == "support":
                fail(f"{op_id}: a destructive route cannot be open to support")
        if op.get("x-notifies-owner") and not op.get("x-audit-action"):
            fail(f"{op_id}: an owner-notified route must be audited")
        action = op.get("x-audit-action")
        if action and action not in audit_actions:
            fail(f"{op_id}: x-audit-action {action} is not in the AuditAction enum")
        if action and not op.get("x-audit-independent") and "503" not in statuses:
            fail(f"{op_id}: an audited route must declare 503 (audit_unavailable)")
        if op.get("x-audit-independent") and not (mutating and op.get("x-allowed-when-frozen")):
            fail(f"{op_id}: only freeze, unfreeze and containment writes may be audit-independent")
        if not mutating and op_id not in NO_AUDIT_GETS and not action:
            fail(f"{op_id}: a read route must be audited")
        if "Cursor" in names and not mutating:
            ok = next(iter(op["responses"].get("200", {}).get("content", {}).values()), {}).get("schema", {})
            if "next_cursor" not in resolve(components, ok).get("properties", {}):
                fail(f"{op_id}: a paginated route must return next_cursor")

        # 7 (cont). owner-only management, audited single-account reads
        if (path.startswith("/admin/v1/admins") or path.startswith("/admin/v1/invitations")) and role not in ("owner", "invitee"):
            fail(f"{op_id}: admin management routes are owner only")
        # owner-only request fields and values exist in the request schema
        for field in op.get("x-owner-only-fields", []):
            if field not in body_schema(spec, op).get("properties", {}):
                fail(f"{op_id}: x-owner-only-fields names {field}, which is not in the request schema")
        for field in op.get("x-owner-only-values", {}):
            if field not in body_schema(spec, op).get("properties", {}):
                fail(f"{op_id}: x-owner-only-values names {field}, which is not in the request schema")

    # request schemas without a user notification switch
    for name in NO_USER_SWITCH_SCHEMAS:
        if "notify_user" in components["schemas"][name].get("properties", {}):
            fail(f"schema {name}: the user is always notified, so it must not have notify_user")

    # 8. the operation matrix and the frozen list in the design document
    text = ADMIN_DOC.read_text(encoding="utf-8")
    matrix = parse_md_matrix(text)
    if matrix is None:
        fail("docs/cloud-admin.md: operation matrix markers not found")
    else:
        spec_ops = {}
        for path, method, op in iter_operations(spec):
            spec_ops[op["operationId"]] = (method, path, op)
        for op_id in sorted(set(spec_ops) - set(matrix)):
            fail(f"docs/cloud-admin.md: {op_id} is missing from the operation matrix")
        for op_id in sorted(set(matrix) - set(spec_ops)):
            fail(f"docs/cloud-admin.md: the matrix lists unknown operation {op_id}")
        for op_id in sorted(set(spec_ops) & set(matrix)):
            method, path, op = spec_ops[op_id]
            cells = matrix[op_id]
            mutating = method != "get"
            expect = [
                f"`{method.upper()} {path}`", op["x-required-role"], "yes" if op["x-requires-stepup"] else "no",
                ("yes" if op.get("x-allowed-when-frozen") else "no") if mutating else "yes", op["x-phase"],
                "yes" if op["x-notifies-owner"] else "no", f"`{op.get('x-audit-action', '-')}`",
            ]
            names_ = ["route", "role", "step-up", "allowed while frozen", "phase", "owner email", "audit action"]
            for n, e, got in zip(names_, expect, cells[1:]):
                if e != got:
                    fail(f"docs/cloud-admin.md: matrix {n} of {op_id} is {got}, the contract says {e}")
    ceilings_md = re.search(r"<!-- ceilings:start -->(.*?)<!-- ceilings:end -->", text, re.S)
    if not ceilings_md:
        fail("docs/cloud-admin.md: ceilings markers not found")
    else:
        doc_ceilings = {}
        for line in ceilings_md.group(1).splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) == 2 and cells[0].startswith("`"):
                doc_ceilings[cells[0].strip("`")] = cells[1]
        for field, (schema_name, prop) in CEILING_FIELDS.items():
            maximum = components["schemas"][schema_name]["properties"][prop].get("maximum")
            if str(maximum) != doc_ceilings.get(field):
                fail(f"docs/cloud-admin.md: ceiling of {field} is {doc_ceilings.get(field)}, the schema maximum is {maximum}")
        for field in sorted(set(doc_ceilings) - set(CEILING_FIELDS)):
            fail(f"docs/cloud-admin.md: ceilings table lists unknown field {field}")
    frozen_list = parse_md_frozen_list(text)
    if frozen_list is None:
        fail("docs/cloud-admin.md: frozen-list markers not found")
    elif frozen_list != frozen_ops:
        fail(f"docs/cloud-admin.md: the list of writes allowed while frozen differs from the contract "
             f"(only in doc: {sorted(frozen_list - frozen_ops)}, only in contract: {sorted(frozen_ops - frozen_list)})")

    # 9. recursive property checks (nested and inline schemas, operations included)
    def visit(root, props, node):
        for prop in props:
            if prop in ADMIN_FORBIDDEN_PROPERTIES:
                fail(f"{root}: forbidden property {prop}")
            homes = ADMIN_SINGLE_HOME_PROPERTIES.get(prop)
            if homes is not None and root not in homes:
                fail(f"{root}: property {prop} is allowed only in {sorted(homes)}")

    for name, schema in components["schemas"].items():
        walk_schemas(schema, name, visit)
    for path, method, op in iter_operations(spec):
        walk_schemas(op, "inline:" + op["operationId"], visit)

    audit_props = set(components["schemas"]["AuditRow"]["properties"])
    for banned in ("ip", "ip_address", "user_agent", "email", "token", "content", "reason"):
        if banned in audit_props:
            fail(f"AuditRow must not have a {banned} property")
    params_schemas = [n for n in components["schemas"] if n.startswith("Params")]
    for name in params_schemas:
        schema = components["schemas"][name]
        if schema.get("additionalProperties") is not False:
            fail(f"{name}: an audit params schema must set additionalProperties false")
        for prop, ps in (schema.get("properties") or {}).items():
            kinds = ps.get("type")
            kinds = kinds if isinstance(kinds, list) else [kinds]
            if "string" in kinds and not any(k in ps for k in ("enum", "maxLength", "pattern", "format", "const", "$ref")):
                fail(f"{name}.{prop}: a string in audit params needs an enum, a pattern, a format or a maxLength")
            if "object" in kinds or "array" in kinds:
                fail(f"{name}.{prop}: audit params hold scalars only")
        if name != "ParamsNone" and not schema.get("required"):
            fail(f"{name}: a non-empty params schema must have required properties (so the oneOf is exclusive)")
    row = components["schemas"]["AuditRow"]
    oneof = {o["$ref"].split("/")[-1] for o in row["properties"]["params"]["oneOf"]}
    if oneof != set(params_schemas):
        fail("AuditRow.params oneOf must list every Params* schema")
    mapped = {}
    for entry in row.get("allOf", []):
        for action in entry["if"]["properties"]["action"]["enum"]:
            if action in mapped:
                fail(f"AuditRow: action {action} is mapped to two params schemas")
            mapped[action] = entry["then"]["properties"]["params"]["$ref"].split("/")[-1]
    for action in sorted(audit_actions - set(mapped)):
        fail(f"AuditRow: action {action} has no params schema")
    for action in sorted(set(mapped) - audit_actions):
        fail(f"AuditRow: params mapping names unknown action {action}")


def path_matches(template, path):
    pattern = "/".join("[^/]+" if seg.startswith("{") else re.escape(seg) for seg in template.split("/"))
    return re.fullmatch(pattern, path.split("?")[0]) is not None


def iter_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from iter_strings(value)
    elif isinstance(node, list):
        for value in node:
            yield from iter_strings(value)


def lint_admin_fixture(spec, label, fx, path_to_ops):
    req = fx["request"]
    headers = {k.lower(): v for k, v in req.get("headers", {}).items()}
    method = req["method"].lower()
    op = next((o for p, m, o in iter_operations(spec) if o.get("operationId") == fx["operation"]), None)
    mutating = method != "get"
    status = fx["response"]["status"]
    code = ((fx["response"].get("body") or {}).get("error") or {}).get("code")
    if "authorization" in headers:
        fail(f"{label}: an admin request must not carry an Authorization bearer header")
    if "cf-access-jwt-assertion" not in headers:
        fail(f"{label}: an admin request must carry Cf-Access-Jwt-Assertion")
    template = next((p for p, m, o in iter_operations(spec) if o is op), None)
    if template is None or not path_matches(template, req["path"]) or path_to_ops[template][method] is not op:
        fail(f"{label}: method or path does not match operation {fx['operation']}")
    if mutating != (method != "get"):
        fail(f"{label}: unexpected method")
    exempt = op.get("x-csrf-exempt", False)
    if not exempt and "x-studentllm-admin-csrf" not in headers:
        fail(f"{label}: the session/CSRF header is required")
    if exempt and "x-studentllm-admin-csrf" in headers:
        fail(f"{label}: an exempt operation must not send the session/CSRF header")
    takes_key = mutating and not op.get("x-read-only") and op.get("x-required-role") != "invitee"
    if takes_key and "idempotency-key" not in headers:
        fail(f"{label}: a state-changing request needs an Idempotency-Key")
    if not takes_key and "idempotency-key" in headers:
        fail(f"{label}: this request must not carry an Idempotency-Key")
    if op.get("x-requires-stepup"):
        has = "x-studentllm-admin-stepup" in headers
        if 200 <= status < 300 and not has and not op.get("x-stepup-alternative"):
            fail(f"{label}: a successful step-up action must carry the step-up header")
        if code == "stepup_required" and has:
            fail(f"{label}: stepup_required fixtures must not carry the step-up header")
    elif "x-studentllm-admin-stepup" in headers:
        fail(f"{label}: this operation takes no step-up header")
    if re.search(r"\b[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9.-]+\.[a-z]{2,}\b", json.dumps(fx).replace("***@", "x@")):
        fail(f"{label}: fixtures must only use example.invalid addresses")
    for text in iter_strings(fx):
        if IPV4.search(text):
            fail(f"{label}: a fixture string looks like an IP address")
        if SPELLED_EMAIL.search(text):
            fail(f"{label}: a fixture string looks like a spelled-out email address")


def check_fixture(ctx, label, fx):
    spec, components, operations, error_codes, path_to_ops, admin = (
        ctx["spec"], ctx["components"], ctx["operations"], ctx["error_codes"], ctx["path_to_ops"], ctx["admin"])
    op = operations.get(fx["operation"])
    if op is None:
        fail(f"{label}: unknown operation {fx['operation']}")
        return
    status = str(fx["response"]["status"])
    if status not in op["responses"]:
        fail(f"{label}: status {status} is not declared by {fx['operation']}")
    if admin:
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
    if "ndjson" in resp:
        row_validator = schema_for(components, "AuditRow")
        for i, row in enumerate(resp["ndjson"]):
            check(row_validator, row, f"{label} line {i + 1}")
        verify_audit_chain(resp["ndjson"], label, contiguous=True)
        return
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
        return

    if schema_name is None:
        if resp.get("body") is not None:
            fail(f"{label}: response has a body but no response_schema")
        return
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


def validate_contract(name, spec_path, fixtures_dir, admin_spec_check=None, public_spec=None):
    global _capture
    print(f"== {name} ==")
    spec = yaml.safe_load(spec_path.read_text(encoding="utf-8"))
    try:
        validate_openapi(spec)
    except Exception as exc:  # the library raises several error types
        fail(f"{name}: OpenAPI document is invalid: {exc}")
        return None
    print("OpenAPI document is valid")

    components = spec["components"]
    operations = {}
    path_to_ops = {}
    for path, method, op in iter_operations(spec):
        path_to_ops.setdefault(path, {})[method] = op
        if "operationId" in op:
            operations[op["operationId"]] = op
    ctx = dict(spec=spec, components=components, operations=operations, path_to_ops=path_to_ops,
               error_codes=set(components["schemas"]["ErrorCode"]["enum"]), admin=admin_spec_check is not None)

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
        check_fixture(ctx, fname, fx)
    print(f"{len(listed & present)} fixtures checked")

    negatives = index.get("negative_fixtures", [])
    if negatives:
        neg_dir = fixtures_dir / "negative"
        present_neg = {p.name for p in neg_dir.glob("*.json")} if neg_dir.is_dir() else set()
        for fname in sorted(set(negatives) - present_neg):
            fail(f"index.json lists a missing negative fixture: {fname}")
        for fname in sorted(present_neg - set(negatives)):
            fail(f"negative fixture not listed in index.json: {fname}")
        for fname in sorted(set(negatives) & present_neg):
            fx = json.loads((neg_dir / fname).read_text(encoding="utf-8"))
            expect = fx.get("expect_failure")
            if not expect:
                fail(f"negative/{fname}: expect_failure is required")
                continue
            _capture = []
            try:
                check_fixture(ctx, "negative/" + fname, fx)
            finally:
                messages, _capture = _capture, None
            prefix = "negative/" + fname
            if not any(m.startswith(prefix) and m[len(prefix):] == expect for m in messages):
                fail(f"negative/{fname}: expected exactly the failure {expect!r}, got {[m[len(prefix):] for m in messages] or 'none'}")
        print(f"{len(set(negatives) & present_neg)} negative fixtures checked (each must fail)")
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
