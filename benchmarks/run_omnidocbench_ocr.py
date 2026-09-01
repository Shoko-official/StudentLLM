"""Evaluate OCR text recognition on a public OmniDocBench image/annotation derivative.

The runner reports a full-page OCR edit score and an oracle-layout text recognition
score. The second score uses the public ground-truth polygons to isolate recognition
quality from layout detection. Neither score is the overall official OmniDocBench
score, which also covers layout, tables, formulas, and other document tasks.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class TextSpan:
    text: str
    polygon: tuple[float, ...]


@dataclass(frozen=True)
class OcrDetection:
    text: str
    polygon: tuple[tuple[float, float], ...]
    score: float


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    return re.sub(r"\s+", " ", value).strip()


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


def edit_similarity(reference: str, prediction: str) -> float:
    reference = normalize_text(reference)
    prediction = normalize_text(prediction)
    if not reference and not prediction:
        return 1.0
    if not reference or not prediction:
        return 0.0
    return 1.0 - levenshtein_distance(reference, prediction) / max(len(reference), len(prediction))


def _polygon(value: Any) -> tuple[float, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(float(point) for point in value if isinstance(point, (int, float)))


def ground_truth_spans(eval_data: dict[str, Any]) -> list[TextSpan]:
    spans: list[TextSpan] = []
    detections = eval_data.get("layout_dets", [])
    ordered = sorted(
        detections,
        key=lambda item: (
            item.get("order") if isinstance(item.get("order"), (int, float)) else 0,
            item.get("anno_id") if isinstance(item.get("anno_id"), (int, float)) else 0,
        ),
    )
    for detection in ordered:
        if detection.get("ignore"):
            continue
        line_spans = detection.get("line_with_spans") or []
        for span in line_spans:
            text = normalize_text(str(span.get("text") or ""))
            polygon = _polygon(span.get("poly"))
            if text and len(polygon) >= 4:
                spans.append(TextSpan(text=text, polygon=polygon))
        if not line_spans:
            text = normalize_text(str(detection.get("text") or ""))
            polygon = _polygon(detection.get("poly"))
            if text and len(polygon) >= 4:
                spans.append(TextSpan(text=text, polygon=polygon))
    return spans


def ocr_detections(result: Any, minimum_score: float) -> list[OcrDetection]:
    boxes = getattr(result, "boxes", None)
    texts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if boxes is None or texts is None or scores is None:
        return []
    detections: list[OcrDetection] = []
    for box, text, score in zip(boxes, texts, scores):
        polygon = tuple((float(point[0]), float(point[1])) for point in box)
        if len(polygon) < 4 or float(score) < minimum_score:
            continue
        value = normalize_text(str(text))
        if value:
            detections.append(OcrDetection(text=value, polygon=polygon, score=float(score)))
    return detections


def _bbox(polygon: Iterable[tuple[float, float]] | tuple[float, ...]) -> tuple[float, float, float, float]:
    points = list(polygon)
    if points and isinstance(points[0], (int, float)):
        values = [float(value) for value in points]
        xs, ys = values[::2], values[1::2]
    else:
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def _center(polygon: tuple[tuple[float, float], ...]) -> tuple[float, float]:
    left, top, right, bottom = _bbox(polygon)
    return (left + right) / 2, (top + bottom) / 2


def _contains(bbox: tuple[float, float, float, float], point: tuple[float, float]) -> bool:
    left, top, right, bottom = bbox
    return left <= point[0] <= right and top <= point[1] <= bottom


def oracle_span_predictions(spans: list[TextSpan], detections: list[OcrDetection]) -> list[str]:
    assignments: list[list[OcrDetection]] = [[] for _ in spans]
    span_boxes = [_bbox(span.polygon) for span in spans]
    for detection in detections:
        center = _center(detection.polygon)
        matching_indexes = [index for index, bbox in enumerate(span_boxes) if _contains(bbox, center)]
        if matching_indexes:
            index = min(matching_indexes, key=lambda item: (span_boxes[item][2] - span_boxes[item][0]) * (span_boxes[item][3] - span_boxes[item][1]))
            assignments[index].append(detection)
    predictions: list[str] = []
    for detections_for_span in assignments:
        ordered = sorted(detections_for_span, key=lambda item: (_bbox(item.polygon)[1], _bbox(item.polygon)[0]))
        predictions.append(" ".join(item.text for item in ordered))
    return predictions


def page_prediction(detections: list[OcrDetection]) -> str:
    ordered = sorted(detections, key=lambda item: (_bbox(item.polygon)[1], _bbox(item.polygon)[0]))
    return "\n".join(item.text for item in ordered)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="rwood-97/english_OmniDocBench_with_eval")
    parser.add_argument("--config", default="default")
    parser.add_argument("--split", default="train")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--minimum-score", type=float, default=0.0)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    if arguments.limit <= 0 or arguments.offset < 0 or not 0 <= arguments.minimum_score <= 1:
        raise SystemExit("--limit must be positive, --offset cannot be negative, and --minimum-score must be in [0, 1]")

    from datasets import load_dataset
    from rapidocr import RapidOCR

    dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split, streaming=True)
    engine = RapidOCR()
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    for index, sample in enumerate(dataset):
        if index < arguments.offset:
            continue
        spans = ground_truth_spans(sample["eval_data"])
        result = engine(sample["image"])
        detections = ocr_detections(result, arguments.minimum_score)
        reference = "\n".join(span.text for span in spans)
        prediction = page_prediction(detections)
        oracle_predictions = oracle_span_predictions(spans, detections)
        oracle_scores = [edit_similarity(span.text, predicted) for span, predicted in zip(spans, oracle_predictions)]
        rows.append(
            {
                "image_path": str(sample.get("image_path", "")),
                "text_spans": len(spans),
                "ocr_detections": len(detections),
                "full_page_edit_similarity": edit_similarity(reference, prediction),
                "oracle_span_edit_similarity": sum(oracle_scores) / len(oracle_scores) if oracle_scores else 0.0,
                "reference_characters": len(normalize_text(reference)),
            }
        )
        if len(rows) >= arguments.limit:
            break
    if not rows:
        raise SystemExit("The selected OmniDocBench split and offset returned no samples")

    receipt = {
        "benchmark": "OmniDocBench",
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "offset": arguments.offset,
        "samples": len(rows),
        "protocol": "RapidOCR full-page output compared with public text-span annotations using normalized character edit similarity; oracle span score assigns detections whose center falls inside each annotated span",
        "model": "rapidocr",
        "minimum_score": arguments.minimum_score,
        "full_page_edit_similarity": sum(row["full_page_edit_similarity"] for row in rows) / len(rows),
        "oracle_span_edit_similarity": sum(row["oracle_span_edit_similarity"] for row in rows) / len(rows),
        "elapsed_seconds": time.perf_counter() - started,
        "pages": rows,
        "validity": "public English OmniDocBench derivative with images and annotations; text OCR diagnostic, not the overall official OmniDocBench score",
    }
    encoded = json.dumps(receipt, indent=2, ensure_ascii=False)
    print(encoded)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
