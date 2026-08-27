"""Measure ASR robustness on public FLEURS speech mixed with public MUSAN audio."""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

try:
    from run_asr_fleurs import hardware_snapshot, score
except ModuleNotFoundError:
    from benchmarks.run_asr_fleurs import hardware_snapshot, score


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--musan-root", type=Path, required=True, help="Extracted MUSAN root containing the public audio files")
    parser.add_argument("--model", default="small")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--snrs", default="10,0", help="Comma-separated SNR values in dB")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def load_audio(source: str | Path | bytes) -> tuple[np.ndarray, int]:
    if isinstance(source, bytes):
        samples, sample_rate = sf.read(io.BytesIO(source), dtype="float32")
    else:
        samples, sample_rate = sf.read(source, dtype="float32")
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    return np.asarray(samples, dtype=np.float32), sample_rate


def resample(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return samples
    target_length = max(1, round(len(samples) * target_rate / source_rate))
    source_positions = np.linspace(0, len(samples) - 1, num=target_length)
    return np.interp(source_positions, np.arange(len(samples)), samples).astype(np.float32)


def crop_or_tile(samples: np.ndarray, length: int, offset: int) -> np.ndarray:
    if len(samples) == 0:
        raise ValueError("MUSAN audio file is empty")
    offset %= len(samples)
    rotated = np.concatenate((samples[offset:], samples[:offset]))
    repeats = (length + len(rotated) - 1) // len(rotated)
    return np.tile(rotated, repeats)[:length]


def mix_at_snr(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    speech_rms = float(np.sqrt(np.mean(np.square(speech))) + 1e-8)
    noise_rms = float(np.sqrt(np.mean(np.square(noise))) + 1e-8)
    scaled_noise = noise * (speech_rms / (10 ** (snr_db / 20) * noise_rms))
    mixture = speech + scaled_noise
    peak = float(np.max(np.abs(mixture)))
    return mixture / peak if peak > 1 else mixture


def main() -> None:
    arguments = parse_args()
    if arguments.limit < 1:
        raise ValueError("--limit must be positive")
    snrs = [float(value.strip()) for value in arguments.snrs.split(",") if value.strip()]
    if not snrs:
        raise ValueError("--snrs must contain at least one value")

    from datasets import Audio, load_dataset
    from faster_whisper import WhisperModel

    dataset = load_dataset("google/fleurs", "fr_fr", split="test").cast_column("audio", Audio(decode=False))
    examples = dataset.select(range(min(arguments.limit, len(dataset))))
    noise_paths = {
        "musan_noise": arguments.musan_root / "musan/noise/free-sound/noise-free-sound-0001.wav",
        "musan_ambient": arguments.musan_root / "musan/noise/sound-bible/noise-sound-bible-0001.wav",
        "musan_music": arguments.musan_root / "musan/music/hd-classical/music-hd-0022.wav",
        "musan_speech": arguments.musan_root / "musan/speech/librivox/speech-librivox-0001.wav",
    }
    missing = [str(path) for path in noise_paths.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing extracted MUSAN files: " + ", ".join(missing))
    noises = {name: load_audio(path) for name, path in noise_paths.items()}
    model = WhisperModel(arguments.model, device=arguments.device, compute_type=arguments.compute_type)
    conditions = ["clean"] + [f"{name}@{snr:g}dB" for name in noise_paths for snr in snrs]
    totals = {
        condition: {"word_errors": 0, "reference_words": 0, "character_errors": 0, "reference_characters": 0, "audio_seconds": 0.0, "elapsed_seconds": 0.0}
        for condition in conditions
    }
    started_at = time.perf_counter()
    for index, example in enumerate(examples):
        audio = example["audio"]
        source = audio["bytes"] if audio["bytes"] else audio["path"]
        speech, sample_rate = load_audio(source)
        condition_inputs = {"clean": speech}
        for noise_index, (name, (noise, noise_rate)) in enumerate(noises.items()):
            noise = resample(noise, noise_rate, sample_rate)
            for snr in snrs:
                condition = f"{name}@{snr:g}dB"
                offset = arguments.seed + index * 7919 + noise_index * 104729
                condition_inputs[condition] = mix_at_snr(speech, crop_or_tile(noise, len(speech), offset), snr)
        for condition, audio_samples in condition_inputs.items():
            condition_started = time.perf_counter()
            segments, _ = model.transcribe(audio_samples, language="fr", beam_size=5, vad_filter=True)
            hypothesis = " ".join(segment.text for segment in segments).strip()
            word_error, words, character_error, characters = score(example["transcription"], hypothesis)
            totals[condition]["word_errors"] += word_error
            totals[condition]["reference_words"] += words
            totals[condition]["character_errors"] += character_error
            totals[condition]["reference_characters"] += characters
            totals[condition]["audio_seconds"] += len(audio_samples) / sample_rate
            totals[condition]["elapsed_seconds"] += time.perf_counter() - condition_started
        if (index + 1) % 10 == 0 or index + 1 == len(examples):
            print(f"processed={index + 1}/{len(examples)} elapsed_seconds={time.perf_counter() - started_at:.2f}", flush=True)

    result_conditions = {}
    for condition, total in totals.items():
        result_conditions[condition] = {
            **total,
            "wer": total["word_errors"] / total["reference_words"] if total["reference_words"] else None,
            "cer": total["character_errors"] / total["reference_characters"] if total["reference_characters"] else None,
            "rtf": total["elapsed_seconds"] / total["audio_seconds"] if total["audio_seconds"] else None,
        }
    result = {
        "dataset": "google/fleurs",
        "config": "fr_fr",
        "split": "test",
        "evaluation_scope": f"first {len(examples)} examples of the public split",
        "partial": len(examples) < len(dataset),
        "noise_dataset": "MUSAN",
        "noise_sources": {name: str(path) for name, path in noise_paths.items()},
        "snrs_db": snrs,
        "seed": arguments.seed,
        "model": arguments.model,
        "device": arguments.device,
        "compute_type": arguments.compute_type,
        "examples": len(examples),
        "conditions": result_conditions,
        "hardware": hardware_snapshot(),
        "command": " ".join(sys.argv),
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
