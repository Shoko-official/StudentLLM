"""Measure extractive answer coverage after OCR on the public DocVQA split."""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from collections import Counter
from pathlib import Path


def normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^\w]+", "", normalized, flags=re.UNICODE)


def answer_is_visible(ocr_text: str, answers: list[str]) -> bool:
    normalized_text = normalize(ocr_text)
    return any(normalize(answer) and normalize(answer) in normalized_text for answer in answers)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="lmms-lab/DocVQA")
    parser.add_argument("--config", default="DocVQA")
    parser.add_argument("--split", default="validation")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    if arguments.limit <= 0:
        raise SystemExit("--limit must be positive")

    from datasets import load_dataset
    from rapidocr import RapidOCR

    dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split, streaming=True)
    engine = RapidOCR()
    started = time.perf_counter()
    covered = 0
    processed = 0
    question_types: Counter[str] = Counter()

    for sample in dataset:
        result = engine(sample["image"])
        text_values = getattr(result, "txts", None)
        if text_values is None:
            text_values = ()
        ocr_text = "\n".join(str(value) for value in text_values)
        answers = [str(answer) for answer in sample.get("answers", [])]
        covered += answer_is_visible(ocr_text, answers)
        processed += 1
        question_types.update(sample.get("question_types", []))
        if processed >= arguments.limit:
            break

    if not processed:
        raise SystemExit("The selected DocVQA split returned no samples")

    receipt = {
        "benchmark": "DocVQA",
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "protocol": "OCR answer visibility: at least one normalized reference answer occurs in OCR text",
        "model": "rapidocr",
        "samples": processed,
        "ocr_answer_coverage": covered / processed,
        "question_types": dict(sorted(question_types.items())),
        "elapsed_seconds": time.perf_counter() - started,
        "validity": "partial public split; this is an OCR extractability diagnostic, not the official DocVQA ANLS score",
    }
    encoded = json.dumps(receipt, indent=2, ensure_ascii=False)
    print(encoded)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
