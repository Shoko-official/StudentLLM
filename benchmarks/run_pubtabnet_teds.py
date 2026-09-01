"""Evaluate table reconstruction against the public PubTabNet validation split."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def extract_table_markup(value: str) -> str:
    """Remove markdown wrappers while preserving the model's table markup."""
    match = re.search(r"<table\b.*?</table>", value, flags=re.IGNORECASE | re.DOTALL)
    return match.group(0).strip() if match else ""


def levenshtein_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
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
    return previous[-1]


def image_data_url(image: Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@dataclass(frozen=True)
class ProviderConfig:
    base_url: str
    model: str
    api_key: str
    timeout_seconds: float
    max_retries: int


def request_prediction(sample: dict[str, Any], config: ProviderConfig) -> str:
    prompt = (
        "Reconstruct the table in this image as HTML. Preserve the row and column "
        "structure, including colspan and rowspan when visible. Return only one "
        "<table>...</table> element, with no markdown or explanation."
    )
    payload = {
        "model": config.model,
        "temperature": 0,
        "max_tokens": 2048,
        "messages": [
            {"role": "system", "content": "You are a precise table recognition system."},
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


def teds_score(prediction: str, reference: str, structure_only: bool = False) -> float:
    """Compute the PubTabNet TEDS score using the public APTED formulation."""
    if not prediction or not reference:
        return 0.0
    from apted import APTED, Config
    from lxml import html

    class TableTree:
        def __init__(self, tag: str, colspan: int | None = None, rowspan: int | None = None, content: list[str] | None = None):
            self.tag = tag
            self.colspan = colspan
            self.rowspan = rowspan
            self.content = content
            self.children: list[TableTree] = []

    class TedsConfig(Config):
        @staticmethod
        def maximum(*sequences: list[str]) -> int:
            return max((len(sequence) for sequence in sequences), default=0)

        def normalized_distance(self, left: list[str], right: list[str]) -> float:
            maximum = self.maximum(left, right)
            return float(levenshtein_distance("".join(left), "".join(right))) / maximum if maximum else 0.0

        def rename(self, left: TableTree, right: TableTree) -> float:
            if left.tag != right.tag or left.colspan != right.colspan or left.rowspan != right.rowspan:
                return 1.0
            if left.tag == "td" and not structure_only:
                return self.normalized_distance(left.content or [], right.content or [])
            return 0.0

    def table_root(markup: str) -> Any:
        document = html.fromstring(markup, parser=html.HTMLParser(remove_comments=True, encoding="utf-8"))
        if document.tag == "table":
            return document
        tables = document.xpath(".//table")
        return tables[0] if tables else None

    def tree(node: Any) -> TableTree:
        if node.tag == "td":
            content = [] if structure_only else list(node.itertext())
            current = TableTree(
                node.tag,
                int(node.attrib.get("colspan", "1")),
                int(node.attrib.get("rowspan", "1")),
                content,
            )
        else:
            current = TableTree(node.tag)
        if node.tag != "td":
            for child in node:
                if isinstance(child.tag, str):
                    current.children.append(tree(child))
        return current

    predicted_root = table_root(prediction)
    reference_root = table_root(reference)
    if predicted_root is None or reference_root is None:
        return 0.0
    node_count = max(len(predicted_root.xpath(".//*")), len(reference_root.xpath(".//*")))
    if node_count == 0:
        return 0.0
    distance = APTED(tree(predicted_root), tree(reference_root), TedsConfig()).compute_edit_distance()
    return 1.0 - float(distance) / node_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="apoidea/pubtabnet-html")
    parser.add_argument("--config")
    parser.add_argument("--split", default="validation")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--model", default="meta/llama-3.2-11b-vision-instruct")
    parser.add_argument("--base-url", default="https://integrate.api.nvidia.com/v1")
    parser.add_argument("--api-key-env", default="NVIDIA_API_KEY")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout-seconds", type=float, default=180)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    if arguments.limit <= 0 or arguments.offset < 0 or arguments.concurrency <= 0:
        raise SystemExit("--limit and --concurrency must be positive; --offset cannot be negative")
    api_key = os.environ.get(arguments.api_key_env)
    if not api_key:
        raise SystemExit(f"{arguments.api_key_env} is required in the process environment")

    from datasets import load_dataset

    if arguments.config:
        dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split, streaming=True)
    else:
        dataset = load_dataset(arguments.dataset, split=arguments.split, streaming=True)
    samples: list[dict[str, Any]] = []
    for index, sample in enumerate(dataset):
        if index < arguments.offset:
            continue
        samples.append(sample)
        if len(samples) >= arguments.limit:
            break
    if not samples:
        raise SystemExit("The selected PubTabNet range returned no samples")

    config = ProviderConfig(arguments.base_url, arguments.model, api_key, arguments.timeout_seconds, arguments.max_retries)
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=arguments.concurrency) as executor:
        futures = {executor.submit(request_prediction, sample, config): sample for sample in samples}
        for future in as_completed(futures):
            sample = futures[future]
            reference = str(sample["html_table"])
            try:
                raw_prediction = future.result()
                prediction = extract_table_markup(raw_prediction)
                error = None
                score = teds_score(prediction, reference)
                structure_score = teds_score(prediction, reference, structure_only=True)
            except Exception as exception:  # Retain provider and scorer failures in the receipt.
                raw_prediction = ""
                prediction = ""
                score = 0.0
                structure_score = 0.0
                error = f"{type(exception).__name__}: {exception}"
            rows.append(
                {
                    "image_id": str(sample.get("imgid", sample.get("__key__", ""))),
                    "table_type": str(sample.get("type", "")),
                    "prediction": prediction,
                    "raw_prediction_characters": len(raw_prediction),
                    "teds": score,
                    "teds_structure_only": structure_score,
                    "error": error,
                }
            )
    rows.sort(key=lambda row: row["image_id"])
    scored = [row for row in rows if row["error"] is None]
    receipt = {
        "benchmark": "PubTabNet",
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "offset": arguments.offset,
        "samples": len(rows),
        "scored_samples": len(scored),
        "failed_samples": len(rows) - len(scored),
        "protocol": "Public PubTabNet TEDS using APTED tree edit distance; structure-only TEDS is reported alongside content-sensitive TEDS",
        "model": arguments.model,
        "endpoint": arguments.base_url,
        "concurrency": arguments.concurrency,
        "teds": sum(row["teds"] for row in rows) / len(rows),
        "teds_structure_only": sum(row["teds_structure_only"] for row in rows) / len(rows),
        "elapsed_seconds": time.perf_counter() - started,
        "predictions": rows,
        "validity": "public PubTabNet-derived validation split; partial provider evaluation, not a full leaderboard result",
    }
    encoded = json.dumps(receipt, indent=2, ensure_ascii=False)
    print(encoded)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
