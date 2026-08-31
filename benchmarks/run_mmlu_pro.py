"""Run the public MMLU-Pro benchmark against an OpenAI-compatible chat server.

The Qwen3 model family can return its reasoning channel without a final
content channel unless thinking is disabled. This adapter keeps the official
lm-evaluation-harness task and scoring intact while adding the documented
``/no_think`` control token to the final user message.
"""

import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from lm_eval.models.openai_completions import LocalChatCompletion
from lm_eval.__main__ import cli_evaluate


_original_create_payload = LocalChatCompletion._create_payload


def _api_key(self):
    if "nvidia.com" in str(getattr(self, "base_url", "")):
        return os.environ.get("NVIDIA_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
    return os.environ.get("OPENAI_API_KEY") or os.environ.get("NVIDIA_API_KEY", "")


def _create_payload_without_thinking(self, messages, *args, **kwargs):
    payload = _original_create_payload(self, messages, *args, **kwargs)
    payload_messages = payload.get("messages", [])

    if payload_messages and payload_messages[-1].get("role") == "user":
        content = payload_messages[-1].get("content", "")
        if isinstance(content, str) and "/no_think" not in content:
            payload_messages[-1] = {
                **payload_messages[-1],
                "content": f"{content}\n/no_think",
            }

    return payload


LocalChatCompletion._create_payload = _create_payload_without_thinking
LocalChatCompletion.api_key = property(_api_key)


if __name__ == "__main__":
    cli_evaluate()
