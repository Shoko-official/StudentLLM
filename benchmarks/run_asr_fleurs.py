"""Run a reproducible public FLEURS ASR evaluation with faster-whisper."""

from __future__ import annotations

import argparse
import io
import json
import os
import platform
import subprocess
import sys
import time
import unicodedata
from pathlib import Path


def normalize(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    normalized = "".join(character if character.isalnum() or character.isspace() or character == "'" else " " for character in normalized)
    return " ".join(normalized.split())


def edit_distance(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for reference_index, reference_token in enumerate(reference, start=1):
        current = [reference_index]
        for hypothesis_index, hypothesis_token in enumerate(hypothesis, start=1):
            current.append(min(
                current[-1] + 1,
                previous[hypothesis_index] + 1,
                previous[hypothesis_index - 1] + (reference_token != hypothesis_token),
            ))
        previous = current
    return previous[-1]


def score(reference: str, hypothesis: str) -> tuple[int, int, int, int]:
    normalized_reference = normalize(reference)
    normalized_hypothesis = normalize(hypothesis)
    reference_words = normalized_reference.split()
    hypothesis_words = normalized_hypothesis.split()
    reference_characters = list(normalized_reference.replace(" ", ""))
    hypothesis_characters = list(normalized_hypothesis.replace(" ", ""))
    return (
        edit_distance(reference_words, hypothesis_words),
        len(reference_words),
        edit_distance(reference_characters, hypothesis_characters),
        len(reference_characters),
    )


def hardware_snapshot() -> dict[str, object]:
    snapshot: dict[str, object] = {
        "os": platform.platform(),
        "cpu": platform.processor(),
        "logical_cpus": os.cpu_count(),
        "ram_gb": None,
        "gpu": [],
        "thread_setting": os.environ.get("OMP_NUM_THREADS", "library default"),
        "power_mode": "not captured",
    }
    try:
        import psutil

        snapshot["ram_gb"] = round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except ImportError:
        pass
    try:
        completed = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,temperature.gpu", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        snapshot["gpu"] = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="small", help="faster-whisper model name or local path")
    parser.add_argument("--config", default="fr_fr", help="FLEURS language configuration")
    parser.add_argument("--split", default="test")
    parser.add_argument("--limit", type=int, help="evaluate only the first N public examples")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()

    from datasets import Audio, load_dataset
    from faster_whisper import WhisperModel

    dataset = load_dataset("google/fleurs", arguments.config, split=arguments.split).cast_column("audio", Audio(decode=False))
    examples = dataset if arguments.limit is None else dataset.select(range(min(arguments.limit, len(dataset))))
    model = WhisperModel(arguments.model, device=arguments.device, compute_type=arguments.compute_type)

    word_errors = word_count = character_errors = character_count = 0
    audio_seconds = 0.0
    started_at = time.perf_counter()
    for example in examples:
        audio = example["audio"]
        audio_source = io.BytesIO(audio["bytes"]) if audio["bytes"] else audio["path"]
        segments, info = model.transcribe(audio_source, language=arguments.config.split("_")[0], beam_size=5, vad_filter=True)
        hypothesis = " ".join(segment.text for segment in segments).strip()
        word_error, words, character_error, characters = score(example["transcription"], hypothesis)
        word_errors += word_error
        word_count += words
        character_errors += character_error
        character_count += characters
        audio_seconds += info.duration

    elapsed_seconds = time.perf_counter() - started_at
    result = {
        "dataset": "google/fleurs",
        "config": arguments.config,
        "split": arguments.split,
        "evaluation_scope": "full public split" if arguments.limit is None else f"first {len(examples)} examples of the public split",
        "partial": arguments.limit is not None,
        "model": arguments.model,
        "device": arguments.device,
        "compute_type": arguments.compute_type,
        "examples": len(examples),
        "reference_words": word_count,
        "reference_characters": character_count,
        "wer": word_errors / word_count if word_count else None,
        "cer": character_errors / character_count if character_count else None,
        "audio_seconds": audio_seconds,
        "elapsed_seconds": elapsed_seconds,
        "rtf": elapsed_seconds / audio_seconds if audio_seconds else None,
        "hardware": hardware_snapshot(),
        "command": " ".join(sys.argv),
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
