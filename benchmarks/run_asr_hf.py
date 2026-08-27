"""Run a reproducible ASR evaluation on a public Hugging Face audio dataset."""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

try:
    from run_asr_fleurs import hardware_snapshot, score
except ModuleNotFoundError:
    from benchmarks.run_asr_fleurs import hardware_snapshot, score


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="Public Hugging Face dataset identifier")
    parser.add_argument("--config", required=True, help="Dataset configuration name")
    parser.add_argument("--split", default="test")
    parser.add_argument("--reference-field", default="transcript", help="Dataset field containing the reference transcript")
    parser.add_argument("--language", required=True, help="Language code passed to faster-whisper")
    parser.add_argument("--model", default="small", help="faster-whisper model name or local path")
    parser.add_argument("--limit", type=int, help="Evaluate only the first N public examples")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()

    from datasets import Audio, load_dataset
    from faster_whisper import WhisperModel

    dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split).cast_column("audio", Audio(decode=False))
    examples = dataset if arguments.limit is None else dataset.select(range(min(arguments.limit, len(dataset))))
    model = WhisperModel(arguments.model, device=arguments.device, compute_type=arguments.compute_type)

    word_errors = word_count = character_errors = character_count = 0
    audio_seconds = 0.0
    started_at = time.perf_counter()
    for example in examples:
        audio = example["audio"]
        audio_source = io.BytesIO(audio["bytes"]) if audio["bytes"] else audio["path"]
        segments, info = model.transcribe(audio_source, language=arguments.language, beam_size=5, vad_filter=True)
        hypothesis = " ".join(segment.text for segment in segments).strip()
        word_error, words, character_error, characters = score(str(example[arguments.reference_field]), hypothesis)
        word_errors += word_error
        word_count += words
        character_errors += character_error
        character_count += characters
        audio_seconds += info.duration

    elapsed_seconds = time.perf_counter() - started_at
    result = {
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "reference_field": arguments.reference_field,
        "language": arguments.language,
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
