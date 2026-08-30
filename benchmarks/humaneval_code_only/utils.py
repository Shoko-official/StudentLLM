"""Scoring and response filtering for the explicit HumanEval code-only protocol."""

from __future__ import annotations

import re

def pass_at_k(references: list[str], predictions: list[list[str]], k: list[int] | None = None):
    if k is None:
        raise ValueError("k is required")
    import evaluate as hf_evaluate

    compute_ = hf_evaluate.load("code_eval")
    return compute_.compute(references=references, predictions=predictions, k=k)[0]


def extract_code(response: str, entry_point: str) -> str:
    """Keep the code block or code region from a chat-style completion."""
    text = response or ""
    fenced = re.findall(r"```(?:python|py)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
    candidates = fenced or [text]
    marker = f"def {entry_point}"
    for candidate in candidates:
        if marker in candidate:
            return candidate.strip() if fenced else candidate[candidate.find(marker) :].rstrip()
    return candidates[0].rstrip()


def build_predictions_code_only(resps: list[list[str]], docs: list[dict]) -> list[list[str]]:
    return [
        [doc["prompt"] + extract_code(response, doc["entry_point"]) for response in responses]
        for responses, doc in zip(resps, docs)
    ]
