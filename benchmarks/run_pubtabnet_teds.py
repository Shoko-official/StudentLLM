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


def sample_image_id(sample: dict[str, Any]) -> str:
    return str(sample.get("imgid", sample.get("__key__", "")))


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
    if isinstance(image, dict):
        from PIL import Image

        image_bytes = image.get("bytes")
        if image_bytes is not None:
            image = Image.open(io.BytesIO(image_bytes))
        elif image.get("path"):
            image = Image.open(image["path"])
        else:
            raise ValueError("PubTabNet image metadata has neither bytes nor a path")
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
    parser.add_argument(
        "--checkpoint-path",
        type=Path,
        help="Persist completed predictions so an interrupted run can resume",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=100,
        help="Save a checkpoint after this many completed examples (default: 100)",
    )
    parser.add_argument(
        "--expected-samples",
        type=int,
        help="Expected public split size used to label a complete evaluation",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def checkpoint_metadata(arguments: argparse.Namespace) -> dict[str, Any]:
    return {
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "limit": arguments.limit,
        "offset": arguments.offset,
        "model": arguments.model,
        "base_url": arguments.base_url,
        "api_key_env": arguments.api_key_env,
        "expected_samples": arguments.expected_samples,
    }


def save_checkpoint(path: Path, metadata: dict[str, Any], rows: list[dict[str, Any]], elapsed_seconds: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": metadata,
        "state": {
            "completed_examples": len(rows),
            "elapsed_seconds": elapsed_seconds,
            "rows": rows,
        },
    }
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for attempt in range(5):
        try:
            temporary.replace(path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(2**attempt)


def load_checkpoint(path: Path, metadata: dict[str, Any]) -> tuple[list[dict[str, Any]], float]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("metadata") != metadata:
        raise ValueError(f"checkpoint metadata does not match this evaluation: {path}")
    state = payload.get("state")
    rows = state.get("rows") if isinstance(state, dict) else None
    elapsed_seconds = state.get("elapsed_seconds") if isinstance(state, dict) else None
    if not isinstance(rows, list) or not isinstance(elapsed_seconds, (int, float)):
        raise ValueError(f"checkpoint state is invalid: {path}")
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"checkpoint rows are invalid: {path}")
    image_ids = [row.get("image_id") for row in rows]
    if len(image_ids) != len(set(image_ids)):
        raise ValueError(f"checkpoint contains duplicate image ids: {path}")
    return rows, float(elapsed_seconds)


def main() -> None:
    arguments = parse_args()
    if arguments.limit <= 0 or arguments.offset < 0 or arguments.concurrency <= 0:
        raise SystemExit("--limit and --concurrency must be positive; --offset cannot be negative")
    if arguments.checkpoint_every <= 0:
        raise SystemExit("--checkpoint-every must be positive")
    if arguments.expected_samples is not None and arguments.expected_samples <= 0:
        raise SystemExit("--expected-samples must be positive")
    api_key = os.environ.get(arguments.api_key_env)
    if not api_key:
        raise SystemExit(f"{arguments.api_key_env} is required in the process environment")

    from datasets import load_dataset

    if arguments.config:
        dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split, streaming=True)
    else:
        dataset = load_dataset(arguments.dataset, split=arguments.split, streaming=True)
    from datasets.features import Image

    dataset = dataset.cast_column("image", Image(decode=False))
    config = ProviderConfig(arguments.base_url, arguments.model, api_key, arguments.timeout_seconds, arguments.max_retries)
    metadata = checkpoint_metadata(arguments)
    rows, saved_elapsed_seconds = (
        load_checkpoint(arguments.checkpoint_path, metadata)
        if arguments.checkpoint_path and arguments.checkpoint_path.exists()
        else ([], 0.0)
    )
    completed_ids = {row["image_id"] for row in rows}
    started = time.perf_counter() - saved_elapsed_seconds

    def evaluate_batch(batch: list[dict[str, Any]], executor: ThreadPoolExecutor) -> None:
        futures = {executor.submit(request_prediction, sample, config): sample for sample in batch}
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
                    "image_id": sample_image_id(sample),
                    "table_type": str(sample.get("type", "")),
                    "prediction": prediction,
                    "raw_prediction_characters": len(raw_prediction),
                    "teds": score,
                    "teds_structure_only": structure_score,
                    "error": error,
                }
            )
            completed_ids.add(sample_image_id(sample))
            if arguments.checkpoint_path and len(rows) % arguments.checkpoint_every == 0:
                save_checkpoint(arguments.checkpoint_path, metadata, rows, time.perf_counter() - started)

    try:
        with ThreadPoolExecutor(max_workers=arguments.concurrency) as executor:
            selected = 0
            batch: list[dict[str, Any]] = []
            batch_size = max(arguments.concurrency * 4, arguments.checkpoint_every)
            for index, sample in enumerate(dataset):
                if index < arguments.offset:
                    continue
                if selected >= arguments.limit:
                    break
                selected += 1
                if sample_image_id(sample) in completed_ids:
                    continue
                batch.append(sample)
                if len(batch) >= batch_size:
                    evaluate_batch(batch, executor)
                    batch = []
            if batch:
                evaluate_batch(batch, executor)
            if selected == 0:
                raise SystemExit("The selected PubTabNet range returned no samples")
    except KeyboardInterrupt:
        if arguments.checkpoint_path:
            save_checkpoint(arguments.checkpoint_path, metadata, rows, time.perf_counter() - started)
        raise
    rows.sort(key=lambda row: row["image_id"])
    scored = [row for row in rows if row["error"] is None]
    complete_split = arguments.expected_samples is not None and len(rows) == arguments.expected_samples and arguments.offset == 0
    receipt = {
        "benchmark": "PubTabNet",
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "offset": arguments.offset,
        "samples": len(rows),
        "scored_samples": len(scored),
        "failed_samples": len(rows) - len(scored),
        "evaluation_scope": "complete public split" if complete_split else f"selected public range: offset {arguments.offset}, limit {arguments.limit}",
        "partial": not complete_split,
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
    if complete_split:
        receipt["validity"] = "complete public PubTabNet-derived validation split; official metric and model predictions; provider failures retained and scored as zero"
    encoded = json.dumps(receipt, indent=2, ensure_ascii=False)
    print(encoded)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
