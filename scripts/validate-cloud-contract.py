#!/usr/bin/env python3
"""Validate the planned cloud API contract and its shared fixtures.

Checks, with no network access:
  1. docs/cloud-api.openapi.yaml is a valid OpenAPI 3.1 document;
  2. every file in docs/cloud-api-fixtures/ is listed in index.json and vice versa;
  3. each fixture names a real operationId, uses a status code the operation declares,
     and its request body, response body and SSE event payloads satisfy the JSON Schemas
     of the contract (JSON Schema 2020-12, with format checking enabled);
  4. error fixtures use a code from the ErrorCode enum and never carry a secret in the envelope.

Usage:
  python scripts/validate-cloud-contract.py
Requires: pyyaml, jsonschema, openapi-spec-validator, rfc3339-validator (see requirements-cloud-contract.txt).
"""
import json
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "docs" / "cloud-api.openapi.yaml"
FIXTURES = ROOT / "docs" / "cloud-api-fixtures"
SECRET_KEYS = {"manage_token", "refresh_token", "access_token", "code", "code_verifier"}

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


def main():
    spec = yaml.safe_load(SPEC.read_text(encoding="utf-8"))
    try:
        validate_openapi(spec)
    except Exception as exc:  # the library raises several error types
        fail(f"OpenAPI document is invalid: {exc}")
        return
    print("OpenAPI document is valid")

    components = spec["components"]
    error_codes = set(components["schemas"]["ErrorCode"]["enum"])
    operations = {}
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if isinstance(op, dict) and "operationId" in op:
                operations[op["operationId"]] = op

    index = json.loads((FIXTURES / "index.json").read_text(encoding="utf-8"))
    listed = set(index["fixtures"])
    present = {p.name for p in FIXTURES.glob("*.json") if p.name != "index.json"}
    for name in sorted(listed - present):
        fail(f"index.json lists a missing file: {name}")
    for name in sorted(present - listed):
        fail(f"fixture not listed in index.json: {name}")

    for name in sorted(listed & present):
        fx = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        label = name
        op = operations.get(fx["operation"])
        if op is None:
            fail(f"{label}: unknown operation {fx['operation']}")
            continue
        status = str(fx["response"]["status"])
        if status not in op["responses"]:
            fail(f"{label}: status {status} is not declared by {fx['operation']}")

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
        if schema_name == "Error":
            err = body["error"]
            if err["code"] not in error_codes:
                fail(f"{label}: unknown error code {err['code']}")
            for key in (err.get("details") or {}):
                if key in SECRET_KEYS:
                    fail(f"{label}: secret-bearing key {key} in error.details")

    print(f"{len(listed & present)} fixtures checked")


if __name__ == "__main__":
    main()
    if errors:
        print(f"{len(errors)} problem(s)")
        sys.exit(1)
    print("OK")
