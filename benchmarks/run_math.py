"""Run official math tasks with Windows-compatible math verification.

The official math tasks use ``math_verify`` for symbolic answer checking. On
Windows, its default timeout implementation starts a child process for every
parse and can fail when the parent process is attached to a redirected
terminal. This runner keeps the official task and metrics while disabling
that nested timeout for the single-worker benchmark process.
"""

import os

import math_verify
from math_verify import grader, parser

from run_mmlu_pro import cli_evaluate


def _no_timeout(timeout_seconds=None):
    def decorator(function):
        return function

    return decorator


def _patch_math_verify_for_windows() -> None:
    if os.name != "nt":
        return

    original_parse = math_verify.parse
    original_verify = math_verify.verify

    parser.timeout = _no_timeout
    grader.timeout = _no_timeout

    def parse_without_nested_timeout(*args, **kwargs):
        kwargs["parsing_timeout"] = None
        return original_parse(*args, **kwargs)

    def verify_without_nested_timeout(*args, **kwargs):
        kwargs["timeout_seconds"] = None
        return original_verify(*args, **kwargs)

    math_verify.parse = parse_without_nested_timeout
    math_verify.verify = verify_without_nested_timeout


if __name__ == "__main__":
    _patch_math_verify_for_windows()
    cli_evaluate()
