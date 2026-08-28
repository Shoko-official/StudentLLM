"""Run the official ARC-Challenge chat task through an OpenAI-compatible API.

The official chat task asks the model to continue the assistant prefix
``The best answer is``. NVIDIA NIM echoes that prefix in the returned content,
so this adapter removes only that provider echo before the official harness
filter and metric are applied.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any

from lm_eval.__main__ import cli_evaluate
from lm_eval.models.openai_completions import LocalChatCompletion


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _api_key(self: Any) -> str:
    return os.environ.get("OPENAI_API_KEY") or os.environ.get("NVIDIA_API_KEY", "")


def _strip_nvidia_echo(response: str | None) -> str | None:
    if response is None:
        return None
    return re.sub(r"^\s*The best answer is\s*", "", response, count=1, flags=re.IGNORECASE)


LocalChatCompletion.api_key = property(_api_key)
_original_parse_generations = LocalChatCompletion.parse_generations


def _parse_generations_without_provider_echo(
    outputs: Any, **kwargs: Any
) -> list[str | None]:
    responses = _original_parse_generations(outputs, **kwargs)
    return [_strip_nvidia_echo(response) for response in responses]


LocalChatCompletion.parse_generations = staticmethod(
    _parse_generations_without_provider_echo
)


if __name__ == "__main__":
    cli_evaluate()
