"""Run the complete public MMLU-Pro group with resumable category receipts.

The official lm-evaluation-harness group contains fourteen independent public
categories. Running one category per subprocess keeps completed receipts
usable after an interruption and makes the final aggregate auditable.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CATEGORY_ITEM_COUNTS = {
    "biology": 717,
    "business": 789,
    "chemistry": 1_132,
    "computer_science": 410,
    "economics": 844,
    "engineering": 969,
    "health": 818,
    "history": 381,
    "law": 1_101,
    "math": 1_351,
    "other": 924,
    "philosophy": 499,
    "physics": 1_299,
    "psychology": 798,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_category_command(
    python_executable: str,
    benchmark_script: str,
    category: str,
    output_path: Path,
    model: str,
    base_url: str,
    num_concurrent: int,
    max_retries: int,
    num_fewshot: int,
    max_gen_toks: int,
    reasoning_effort: str,
    seed: int,
) -> list[str]:
    return [
        python_executable,
        benchmark_script,
        "run",
        "--model",
        "local-chat-completions",
        "--model_args",
        (
            f"model={model},base_url={base_url},tokenizer_backend=None,"
            f"num_concurrent={num_concurrent},max_retries={max_retries}"
        ),
        "--tasks",
        f"mmlu_pro_{category}",
        "--num_fewshot",
        str(num_fewshot),
        "--batch_size",
        "1",
        "--apply_chat_template",
        "--gen_kwargs",
        f"temperature=0,max_gen_toks={max_gen_toks},reasoning_effort={reasoning_effort},until=None",
        "--seed",
        str(seed),
        "--output_path",
        str(output_path),
        "--log_samples",
    ]


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def latest_category_receipt(output_dir: Path, category: str) -> Path | None:
    prefix = f"mmlu_pro_{category}"
    candidates = sorted(
        output_dir.glob(f"{prefix}*.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        if candidate.name.endswith("_full_summary.json"):
            continue
        if load_json(candidate) is not None:
            return candidate
    return None


def receipt_is_complete(receipt: dict[str, Any], category: str) -> bool:
    task_name = f"mmlu_pro_{category}"
    results = receipt.get("results")
    if not isinstance(results, dict) or task_name not in results:
        return False
    task_result = results[task_name]
    if not isinstance(task_result, dict):
        return False
    return any(
        key.startswith("exact_match")
        for key in task_result
    )


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_categories(value: str) -> list[str]:
    categories = [item.strip() for item in value.split(",") if item.strip()]
    unknown = sorted(set(categories) - set(CATEGORY_ITEM_COUNTS))
    if unknown:
        raise ValueError(f"Unknown MMLU-Pro categories: {', '.join(unknown)}")
    return categories or list(CATEGORY_ITEM_COUNTS)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default=sys.executable, dest="python_executable")
    parser.add_argument(
        "--benchmark-script",
        default=str(Path(__file__).with_name("run_mmlu_pro.py")),
    )
    parser.add_argument("--categories", default=",".join(CATEGORY_ITEM_COUNTS))
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/benchmarks/mmlu-pro/full"))
    parser.add_argument("--model", default="openai/gpt-oss-20b")
    parser.add_argument(
        "--base-url",
        default="https://integrate.api.nvidia.com/v1/chat/completions",
    )
    parser.add_argument("--num-concurrent", type=int, default=4)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--num-fewshot", type=int, default=0)
    parser.add_argument("--max-gen-toks", type=int, default=512)
    parser.add_argument("--reasoning-effort", choices=("low", "medium", "high"), default="low")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        categories = parse_categories(args.categories)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    output_dir = args.output_dir
    manifest_path = output_dir / "mmlu_pro_full_manifest.json"
    summary_path = output_dir / "mmlu_pro_full_summary.json"
    manifest = load_json(manifest_path) or {
        "protocol_version": 1,
        "benchmark": "MMLU-Pro",
        "categories": {},
    }
    manifest["updated_at"] = utc_now()
    manifest["configuration"] = {
        "model": args.model,
        "base_url": args.base_url,
        "num_concurrent": args.num_concurrent,
        "max_retries": args.max_retries,
        "num_fewshot": args.num_fewshot,
        "max_gen_toks": args.max_gen_toks,
        "reasoning_effort": args.reasoning_effort,
        "seed": args.seed,
    }

    for category in categories:
        task_name = f"mmlu_pro_{category}"
        receipt = latest_category_receipt(output_dir, category)
        if not args.force and receipt and receipt_is_complete(load_json(receipt) or {}, category):
            manifest["categories"][category] = {
                "status": "reused",
                "expected_items": CATEGORY_ITEM_COUNTS[category],
                "receipt": str(receipt),
            }
            write_json(manifest_path, manifest)
            print(f"{task_name}: reused {receipt}")
            continue

        output_path = output_dir / f"mmlu_pro_{category}.json"
        command = build_category_command(
            args.python_executable,
            args.benchmark_script,
            category,
            output_path,
            args.model,
            args.base_url,
            args.num_concurrent,
            args.max_retries,
            args.num_fewshot,
            args.max_gen_toks,
            args.reasoning_effort,
            args.seed,
        )
        manifest["categories"][category] = {
            "status": "planned" if args.dry_run else "running",
            "expected_items": CATEGORY_ITEM_COUNTS[category],
            "command": command,
        }
        write_json(manifest_path, manifest)
        print(f"{task_name}: {' '.join(command)}")
        if args.dry_run:
            continue

        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        completed = subprocess.run(command, env=environment, check=False)
        receipt = latest_category_receipt(output_dir, category)
        receipt_data = load_json(receipt) if receipt else None
        complete = completed.returncode == 0 and receipt_data is not None and receipt_is_complete(receipt_data, category)
        manifest["categories"][category].update(
            {
                "status": "complete" if complete else "failed",
                "exit_code": completed.returncode,
                "receipt": str(receipt) if receipt else None,
                "completed_at": utc_now(),
            }
        )
        write_json(manifest_path, manifest)
        if not complete:
            print(f"{task_name}: no complete receipt was produced", file=sys.stderr)
            return 1

    if args.dry_run:
        print(f"Dry run planned {len(categories)} categories")
        return 0

    category_results = {}
    for category in categories:
        entry = manifest["categories"].get(category, {})
        receipt = load_json(Path(entry["receipt"])) if entry.get("receipt") else None
        if not receipt or not receipt_is_complete(receipt, category):
            return 1
        category_results[f"mmlu_pro_{category}"] = receipt.get("results", {}).get(f"mmlu_pro_{category}", {})

    summary = {
        "benchmark": "MMLU-Pro",
        "scope": "complete public test group",
        "categories": categories,
        "total_items": sum(CATEGORY_ITEM_COUNTS[category] for category in categories),
        "results": category_results,
        "manifest": str(manifest_path),
        "generated_at": utc_now(),
    }
    write_json(summary_path, summary)
    print(f"Complete summary written to {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
