"""Run a reproducible ASR evaluation on a public Hugging Face audio dataset."""

from __future__ import annotations

import argparse
import io
import itertools
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
    parser.add_argument("--streaming", action="store_true", help="Stream the public split instead of materializing it locally")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--checkpoint-path",
        type=Path,
        help="Persist resumable aggregate state at this path during long evaluations",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=100,
        help="Save a checkpoint after this many processed examples (default: 100)",
    )
    return parser.parse_args()


def prepare_examples(dataset, limit: int | None, streaming: bool, skip: int = 0):
    """Return an iterable and the expected count when it is known."""
    if skip < 0:
        raise ValueError("skip must be non-negative")
    if streaming:
        return (
            itertools.islice(dataset, skip, limit)
            if limit is not None
            else itertools.islice(dataset, skip, None)
        ), limit
    if limit is None:
        selected = dataset.select(range(skip, len(dataset))) if skip else dataset
        return selected, len(dataset)
    selected = dataset.select(range(skip, min(limit, len(dataset))))
    return selected, min(limit, len(dataset))


def checkpoint_metadata(arguments: argparse.Namespace) -> dict:
    """Return run-defining fields used to reject incompatible resumes."""
    return {
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "reference_field": arguments.reference_field,
        "language": arguments.language,
        "model": arguments.model,
        "streaming": arguments.streaming,
        "device": arguments.device,
        "compute_type": arguments.compute_type,
        "limit": arguments.limit,
    }


def save_checkpoint(path: Path, metadata: dict, state: dict) -> None:
    """Atomically persist aggregate state so an interrupted run can resume safely."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"metadata": metadata, "state": state}
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_checkpoint(path: Path, metadata: dict) -> dict:
    """Load a checkpoint and fail closed when it belongs to another evaluation."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("metadata") != metadata:
        raise ValueError(f"checkpoint metadata does not match this evaluation: {path}")
    state = payload.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("processed_examples"), int):
        raise ValueError(f"checkpoint state is invalid: {path}")
    return state


def main() -> None:
    arguments = parse_args()

    from datasets import Audio, load_dataset
    from faster_whisper import WhisperModel

    if arguments.checkpoint_every <= 0:
        raise ValueError("--checkpoint-every must be positive")

    dataset = load_dataset(
        arguments.dataset,
        arguments.config,
        split=arguments.split,
        streaming=arguments.streaming,
    ).cast_column("audio", Audio(decode=False))
    metadata = checkpoint_metadata(arguments)
    state = (
        load_checkpoint(arguments.checkpoint_path, metadata)
        if arguments.checkpoint_path and arguments.checkpoint_path.exists()
        else {
            "processed_examples": 0,
            "word_errors": 0,
            "reference_words": 0,
            "character_errors": 0,
            "reference_characters": 0,
            "audio_seconds": 0.0,
            "elapsed_seconds": 0.0,
        }
    )
    examples, expected_examples = prepare_examples(
        dataset,
        arguments.limit,
        arguments.streaming,
        skip=state["processed_examples"],
    )
    model = WhisperModel(arguments.model, device=arguments.device, compute_type=arguments.compute_type)

    word_errors = state["word_errors"]
    word_count = state["reference_words"]
    character_errors = state["character_errors"]
    character_count = state["reference_characters"]
    audio_seconds = state["audio_seconds"]
    started_at = time.perf_counter() - state["elapsed_seconds"]
    processed_examples = state["processed_examples"]
    try:
        for index, example in enumerate(examples, start=processed_examples + 1):
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
            processed_examples = index
            if index % 100 == 0 or (expected_examples is not None and index == expected_examples):
                elapsed_seconds = time.perf_counter() - started_at
                expected_label = expected_examples if expected_examples is not None else "?"
                print(
                    f"processed={index}/{expected_label} audio_seconds={audio_seconds:.2f} "
                    f"elapsed_seconds={elapsed_seconds:.2f}",
                    flush=True,
                )
            if arguments.checkpoint_path and index % arguments.checkpoint_every == 0:
                save_checkpoint(
                    arguments.checkpoint_path,
                    metadata,
                    {
                        "processed_examples": processed_examples,
                        "word_errors": word_errors,
                        "reference_words": word_count,
                        "character_errors": character_errors,
                        "reference_characters": character_count,
                        "audio_seconds": audio_seconds,
                        "elapsed_seconds": time.perf_counter() - started_at,
                    },
                )
    except KeyboardInterrupt:
        if arguments.checkpoint_path:
            save_checkpoint(
                arguments.checkpoint_path,
                metadata,
                {
                    "processed_examples": processed_examples,
                    "word_errors": word_errors,
                    "reference_words": word_count,
                    "character_errors": character_errors,
                    "reference_characters": character_count,
                    "audio_seconds": audio_seconds,
                    "elapsed_seconds": time.perf_counter() - started_at,
                },
            )
        raise

    elapsed_seconds = time.perf_counter() - started_at
    result = {
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "reference_field": arguments.reference_field,
        "language": arguments.language,
        "evaluation_scope": "full public split" if arguments.limit is None else f"first {arguments.limit} examples of the public split",
        "partial": arguments.limit is not None,
        "streaming": arguments.streaming,
        "model": arguments.model,
        "device": arguments.device,
        "compute_type": arguments.compute_type,
        "examples": processed_examples,
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
