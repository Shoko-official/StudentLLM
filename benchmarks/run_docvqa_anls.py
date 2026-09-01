"""Evaluate a vision-language model on the public DocVQA validation split.

The adapter uses the official ANLS definition: the best normalized Levenshtein
similarity against the reference answers, with scores below 0.5 set to zero.
Each prediction is retained in the JSON receipt so interrupted or failed
requests remain auditable.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def normalize_answer(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().strip()
    value = re.sub(r"\s+", " ", value)
    return value


def levenshtein_similarity(left: str, right: str) -> float:
    left = normalize_answer(left)
    right = normalize_answer(right)
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, 1):
        current = [left_index]
        for right_index, right_char in enumerate(right, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_char != right_char),
                )
            )
        previous = current
    return 1.0 - previous[-1] / max(len(left), len(right))


def anls(prediction: str, answers: list[str]) -> float:
    best = max((levenshtein_similarity(prediction, answer) for answer in answers), default=0.0)
    return best if best >= 0.5 else 0.0


@dataclass(frozen=True)
class Config:
    base_url: str
    model: str
    api_key: str
    timeout_seconds: float
    max_retries: int


def image_data_url(image: Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def request_prediction(sample: dict[str, Any], config: Config) -> str:
    prompt = (
        "Answer the question about the document image. Return only the shortest "
        "answer text, with no explanation, no JSON, and no markdown.\n\n"
        f"Question: {sample['question']}"
    )
    payload = {
        "model": config.model,
        "temperature": 0,
        "max_tokens": 96,
        "messages": [
            {"role": "system", "content": "You are a precise document question answering system."},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url(sample["image"])}},
                ],
            },
        ],
    }
    request = urllib.request.Request(
        config.base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(config.max_retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=config.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
            content = body["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
            return str(content).strip()
        except (KeyError, TypeError, ValueError, urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt < config.max_retries:
                time.sleep(2**attempt)
    raise RuntimeError(f"prediction failed after retries: {last_error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="lmms-lab/DocVQA")
    parser.add_argument("--config", default="DocVQA")
    parser.add_argument("--split", default="validation")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--model", default="meta/llama-3.2-11b-vision-instruct")
    parser.add_argument("--base-url", default="https://integrate.api.nvidia.com/v1")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout-seconds", type=float, default=120)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    if arguments.limit <= 0 or arguments.offset < 0 or arguments.concurrency <= 0:
        raise SystemExit("--limit and --concurrency must be positive; --offset cannot be negative")
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise SystemExit("NVIDIA_API_KEY is required in the process environment")

    from datasets import load_dataset

    dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split, streaming=True)
    samples: list[dict[str, Any]] = []
    for index, sample in enumerate(dataset):
        if index < arguments.offset:
            continue
        samples.append(sample)
        if len(samples) >= arguments.limit:
            break
    if not samples:
        raise SystemExit("The selected DocVQA range returned no samples")

    config = Config(
        base_url=arguments.base_url,
        model=arguments.model,
        api_key=api_key,
        timeout_seconds=arguments.timeout_seconds,
        max_retries=arguments.max_retries,
    )
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=arguments.concurrency) as executor:
        futures = {executor.submit(request_prediction, sample, config): sample for sample in samples}
        for future in as_completed(futures):
            sample = futures[future]
            answers = [str(answer) for answer in sample.get("answers", [])]
            try:
                prediction = future.result()
                score = anls(prediction, answers)
                error = None
            except Exception as exception:  # Keep failed provider calls visible in the receipt.
                prediction = ""
                score = 0.0
                error = f"{type(exception).__name__}: {exception}"
            rows.append(
                {
                    "question_id": str(sample["questionId"]),
                    "question": str(sample["question"]),
                    "answers": answers,
                    "prediction": prediction,
                    "anls": score,
                    "error": error,
                }
            )
    rows.sort(key=lambda row: row["question_id"])
    scored = [row for row in rows if row["error"] is None]
    receipt = {
        "benchmark": "DocVQA",
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "offset": arguments.offset,
        "samples": len(rows),
        "scored_samples": len(scored),
        "failed_samples": len(rows) - len(scored),
        "protocol": "Official ANLS: max normalized Levenshtein similarity over references, thresholded at 0.5",
        "model": arguments.model,
        "endpoint": arguments.base_url,
        "concurrency": arguments.concurrency,
        "anls": sum(row["anls"] for row in rows) / len(rows),
        "elapsed_seconds": time.perf_counter() - started,
        "predictions": rows,
        "validity": "public validation subset; official metric and model predictions, not a full validation-set score",
    }
    encoded = json.dumps(receipt, indent=2, ensure_ascii=False)
    print(encoded)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
