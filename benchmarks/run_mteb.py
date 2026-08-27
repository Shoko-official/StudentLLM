"""Run a reproducible task from the official Massive Text Embedding Benchmark."""

from __future__ import annotations

import argparse
import json
import platform
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument("--task", default="STSBenchmark.v2")
    parser.add_argument("--split", default="test")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        import mteb
    except ImportError as error:
        raise SystemExit("Install the optional embedding benchmark dependencies first: pip install -r requirements-embeddings.txt") from error

    started_at = time.time()
    tasks = mteb.get_tasks(tasks=[args.task], eval_splits=[args.split])
    model = mteb.get_model(args.model, device=args.device)
    result = mteb.evaluate(
        model,
        tasks=tasks,
        encode_kwargs={"batch_size": args.batch_size},
        overwrite_strategy="always" if args.overwrite else "only-missing",
        show_progress_bar=True,
    )
    task_results = [task_result.model_dump(mode="json") for task_result in result.task_results]
    receipt = {
        "benchmark": "MTEB",
        "task": args.task,
        "split": args.split,
        "model": result.model_name,
        "model_revision": result.model_revision,
        "device": args.device,
        "batch_size": args.batch_size,
        "mteb_version": mteb.__version__,
        "started_at_unix": started_at,
        "elapsed_seconds": time.time() - started_at,
        "platform": platform.platform(),
        "task_results": task_results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for task_result in task_results:
        for split_scores in task_result.get("scores", {}).values():
            for score in split_scores:
                if "main_score" in score:
                    print(f"{task_result['task_name']} {score.get('hf_subset', 'default')}: {score['main_score']:.6f}")


if __name__ == "__main__":
    main()
