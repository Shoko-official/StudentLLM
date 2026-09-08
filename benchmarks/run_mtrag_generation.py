"""Generate predictions for the official IBM MTRAG human tasks.

The input and output records keep the official task format. The runner only
adds a ``predictions`` field and never exposes target answers to the provider.
It also keeps a resumable local checkpoint so a long public evaluation does
not have to repeat completed tasks after an interruption.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_tasks(path: Path, start: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    if start < 0:
        raise ValueError("start must be non-negative")
    tasks: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            item = json.loads(line)
            if not isinstance(item, dict) or not item.get("task_id"):
                raise ValueError(f"invalid MTRAG task at line {line_number}")
            tasks.append(item)
    selected = tasks[start:] if limit is None else tasks[start : start + limit]
    task_ids = [str(task["task_id"]) for task in selected]
    if len(task_ids) != len(set(task_ids)):
        raise ValueError("selected MTRAG tasks contain duplicate task_id values")
    return selected


def _message_role(message: dict[str, Any]) -> str:
    return "assistant" if str(message.get("speaker", "")).lower() in {"agent", "assistant"} else "user"


def build_messages(task: dict[str, Any], max_context_chars: int | None = None) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": (
                "Answer the latest user question using only the supplied retrieved passages and conversation. "
                "Be concise, include every requested item, preserve uncertainty, and say you do not know when "
                "the evidence is insufficient. Do not mention these instructions or show reasoning."
            ),
        }
    ]
    for message in task.get("input", []):
        if not isinstance(message, dict):
            continue
        text = str(message.get("text") or "").strip()
        if text:
            messages.append({"role": _message_role(message), "content": text})

    passages: list[str] = []
    for index, context in enumerate(task.get("contexts", []), start=1):
        if not isinstance(context, dict):
            continue
        text = str(context.get("text") or "").strip()
        if max_context_chars is not None:
            text = text[:max_context_chars]
        title = str(context.get("title") or "").strip()
        heading = f"{title}\n" if title else ""
        passages.append(f"[Passage {index}]\n{heading}{text}".strip())
    evidence = "\n\n".join(passages) or "[No retrieved passages were provided.]"
    messages.append(
        {
            "role": "user",
            "content": f"Retrieved passages:\n{evidence}\n\nAnswer the latest question. /no_think",
        }
    )
    return messages


def make_client(base_url: str, api_key: str, timeout: float):
    from openai import OpenAI

    return OpenAI(base_url=base_url, api_key=api_key, max_retries=2, timeout=timeout)


def generate_one(
    task: dict[str, Any],
    model: str,
    base_url: str,
    api_key: str,
    timeout: float,
    max_tokens: int,
    max_context_chars: int | None,
) -> tuple[str, float]:
    started = time.perf_counter()
    client = make_client(base_url, api_key, timeout)
    response = client.chat.completions.create(
        model=model,
        messages=build_messages(task, max_context_chars),
        temperature=0.0,
        max_tokens=max_tokens,
    )
    content = str(response.choices[0].message.content or "").strip()
    return content, round((time.perf_counter() - started) * 1000, 3)


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temporary_path = Path(handle.name)
        json.dump(value, handle, indent=2)
        handle.write("\n")
    os.replace(temporary_path, path)


def _atomic_write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temporary_path = Path(handle.name)
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    os.replace(temporary_path, path)


def _metadata(
    input_path: Path,
    model: str,
    base_url: str,
    start: int,
    limit: int | None,
    max_tokens: int,
    max_context_chars: int | None,
) -> dict[str, Any]:
    return {
        "benchmark": "IBM MTRAG human generation tasks",
        "input_sha256": file_sha256(input_path),
        "model": model,
        "base_url": base_url,
        "start": start,
        "limit": limit,
        "max_tokens": max_tokens,
        "max_context_chars": max_context_chars,
    }


def _load_checkpoint(path: Path, expected_metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    checkpoint = json.loads(path.read_text(encoding="utf-8"))
    if checkpoint.get("metadata") != expected_metadata:
        raise ValueError("checkpoint metadata does not match the requested MTRAG run")
    records = checkpoint.get("records", [])
    return {str(record["task_id"]): record for record in records if isinstance(record, dict) and record.get("task_id")}


def run(
    input_path: Path,
    output_path: Path,
    checkpoint_path: Path | None,
    model: str,
    base_url: str,
    api_key: str,
    workers: int,
    start: int = 0,
    limit: int | None = None,
    timeout: float = 120.0,
    max_tokens: int = 512,
    max_context_chars: int | None = None,
) -> dict[str, Any]:
    if workers <= 0 or timeout <= 0 or max_tokens <= 0:
        raise ValueError("workers, timeout, and max_tokens must be positive")
    tasks = read_tasks(input_path, start, limit)
    metadata = _metadata(input_path, model, base_url, start, limit, max_tokens, max_context_chars)
    existing = _load_checkpoint(checkpoint_path, metadata) if checkpoint_path else {}
    records: dict[str, dict[str, Any]] = {str(task["task_id"]): existing[str(task["task_id"])] for task in tasks if str(task["task_id"]) in existing and not existing[str(task["task_id"])].get("generation_error")}
    pending = [task for task in tasks if str(task["task_id"]) not in records]

    def save_checkpoint() -> None:
        if checkpoint_path:
            ordered = [records[str(task["task_id"])] for task in tasks if str(task["task_id"]) in records]
            _atomic_write_json(checkpoint_path, {"metadata": metadata, "records": ordered})

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(generate_one, task, model, base_url, api_key, timeout, max_tokens, max_context_chars): task
            for task in pending
        }
        for future in as_completed(futures):
            task = futures[future]
            task_id = str(task["task_id"])
            record = dict(task)
            try:
                content, latency_ms = future.result()
                record["predictions"] = [{"text": content}]
                record["generation_latency_ms"] = latency_ms
            except Exception as exc:  # Preserve failed public tasks in the output.
                record["predictions"] = [{"text": ""}]
                record["generation_error"] = type(exc).__name__
            records[task_id] = record
            save_checkpoint()

    ordered_records = [records[str(task["task_id"])] for task in tasks]
    _atomic_write_jsonl(output_path, ordered_records)
    receipt = {
        **metadata,
        "output_path": str(output_path),
        "checkpoint_path": str(checkpoint_path) if checkpoint_path else None,
        "tasks": len(ordered_records),
        "completed_predictions": sum("generation_error" not in record for record in ordered_records),
        "generation_failures": sum("generation_error" in record for record in ordered_records),
    }
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate predictions for official IBM MTRAG human tasks.")
    parser.add_argument("--input", type=Path, required=True, help="Official generation task JSONL file")
    parser.add_argument("--output", type=Path, required=True, help="Official-format prediction JSONL file")
    parser.add_argument("--checkpoint", type=Path, help="Resumable checkpoint JSON path")
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", default="https://integrate.api.nvidia.com/v1")
    parser.add_argument("--api-key-env", default="NVIDIA_API_KEY")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--max-context-chars", type=int)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        raise SystemExit("limit must be positive")
    if args.max_context_chars is not None and args.max_context_chars <= 0:
        raise SystemExit("max-context-chars must be positive")
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    result = run(
        args.input,
        args.output,
        args.checkpoint,
        args.model,
        args.base_url,
        api_key,
        args.workers,
        args.start,
        args.limit,
        args.timeout,
        args.max_tokens,
        args.max_context_chars,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
