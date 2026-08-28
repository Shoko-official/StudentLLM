"""Re-score official math benchmark samples with Windows-compatible parsing."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from lm_eval.api.metrics import mean_stderr
from lm_eval.tasks.minerva_math.utils import process_results

from run_math import _patch_math_verify_for_windows


def _aggregate(values: list[int]) -> tuple[float, float | str]:
    score = sum(values) / len(values)
    stderr: float | str = mean_stderr(values) if len(values) > 1 else "N/A"
    return score, stderr


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Re-score logged official MATH task samples without regenerating them."
    )
    parser.add_argument("samples", type=Path, help="Path to an lm-eval samples JSONL file")
    parser.add_argument("source_receipt", type=Path, help="Original lm-eval aggregate receipt")
    parser.add_argument("output", type=Path, help="Path for the corrected aggregate receipt")
    return parser.parse_args()


def main() -> None:
    _patch_math_verify_for_windows()
    args = _parse_args()

    values: dict[str, list[int]] = {"exact_match": [], "math_verify": []}
    with args.samples.open(encoding="utf-8") as stream:
        for line in stream:
            sample: dict[str, Any] = json.loads(line)
            result = process_results(sample["doc"], sample["filtered_resps"])
            for metric in values:
                values[metric].append(int(result[metric]))

    source_receipt = json.loads(args.source_receipt.read_text(encoding="utf-8"))
    results: dict[str, Any] = {
        "name": "minerva_math500",
        "alias": "minerva_math500",
        "sample_len": len(next(iter(values.values()))),
    }
    for metric, metric_values in values.items():
        score, stderr = _aggregate(metric_values)
        results[f"{metric},none"] = score
        results[f"{metric}_stderr,none"] = stderr

    receipt = dict(source_receipt)
    receipt["results"] = {"minerva_math500": results}
    receipt["scoring_mode"] = "official_minerva_math_process_results_with_windows_timeout_patch"
    receipt["source_samples"] = str(args.samples)
    receipt["source_receipt"] = str(args.source_receipt)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"SAMPLES={len(next(iter(values.values())))}")
    for metric, metric_values in values.items():
        score, stderr = _aggregate(metric_values)
        print(f"{metric}={score:.10f}")
        print(f"{metric}_stderr={stderr}")
    print(f"OUTPUT={args.output}")


if __name__ == "__main__":
    main()
