"""Evaluate speech translation on the public CoVoST 2 test split."""

from __future__ import annotations

import argparse
import io
import itertools
import json
import sys
import time
from pathlib import Path
from typing import Any, Iterable


def prepare_examples(dataset: Iterable[dict[str, Any]], limit: int | None):
    """Limit a streaming dataset without materialising the public split."""
    return itertools.islice(dataset, limit) if limit is not None else dataset


def decode_audio_bytes(audio_bytes: bytes, target_rate: int):
    """Decode an encoded public audio item to mono float32 samples."""
    import av
    import numpy as np

    container = av.open(io.BytesIO(audio_bytes))
    resampler = av.audio.resampler.AudioResampler(format="fltp", layout="mono", rate=target_rate)
    chunks = []
    for frame in container.decode(audio=0):
        converted = resampler.resample(frame)
        if not isinstance(converted, list):
            converted = [converted]
        chunks.extend(item.to_ndarray() for item in converted)
    tail = resampler.resample(None)
    if not isinstance(tail, list):
        tail = [tail]
    chunks.extend(item.to_ndarray() for item in tail)
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks, axis=1).reshape(-1).astype(np.float32, copy=False)


def score_translations(references: list[str], hypotheses: list[str]) -> dict[str, float | None]:
    """Return SacreBLEU and chrF scores for the collected public references."""
    if not references:
        return {"bleu": None, "chrf": None}
    import sacrebleu

    bleu = sacrebleu.corpus_bleu(hypotheses, [references])
    chrf = sacrebleu.corpus_chrf(hypotheses, [references])
    return {"bleu": bleu.score / 100.0, "chrf": chrf.score / 100.0}


def score_comet(
    sources: list[str],
    references: list[str],
    hypotheses: list[str],
    model_name: str,
    device: str,
    batch_size: int,
    predictor=None,
) -> float | None:
    """Score translations with an optional COMET checkpoint from Unbabel."""
    if not hypotheses:
        return None
    data = [
        {"src": source, "mt": hypothesis, "ref": reference}
        for source, hypothesis, reference in zip(sources, hypotheses, references, strict=True)
    ]
    if predictor is None:
        from comet import download_model, load_from_checkpoint

        checkpoint = download_model(model_name)
        predictor = load_from_checkpoint(checkpoint).predict
    predictions = predictor(
        data,
        batch_size=batch_size,
        gpus=1 if device == "cuda" else 0,
    )
    scores = getattr(predictions, "scores", predictions[0] if isinstance(predictions, tuple) else predictions)
    return sum(float(score) for score in scores) / len(scores)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="fixie-ai/covost2")
    parser.add_argument("--config", default="fr_en")
    parser.add_argument("--split", default="test")
    parser.add_argument("--reference-field", default="translation")
    parser.add_argument("--source-field", default="sentence")
    parser.add_argument("--model", default="facebook/s2t-small-covost2-fr-en-st")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--device", default="cuda", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="float32", choices=("float32", "float16"))
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--num-beams", type=int, default=5)
    parser.add_argument("--comet-model")
    parser.add_argument("--comet-batch-size", type=int, default=8)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()

    import numpy as np
    import torch
    from datasets import Audio, load_dataset
    from transformers import AutoProcessor, Speech2TextForConditionalGeneration

    if arguments.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")
    dtype = torch.float16 if arguments.compute_type == "float16" else torch.float32
    processor = AutoProcessor.from_pretrained(arguments.model)
    sample_rate = int(processor.feature_extractor.sampling_rate)
    model = Speech2TextForConditionalGeneration.from_pretrained(arguments.model, torch_dtype=dtype)
    model = model.to(arguments.device).eval()
    model.generation_config.max_length = None
    dataset = load_dataset(arguments.dataset, arguments.config, split=arguments.split, streaming=True).cast_column(
        "audio", Audio(decode=False)
    )
    examples = prepare_examples(dataset, arguments.limit)
    references: list[str] = []
    hypotheses: list[str] = []
    sources: list[str] = []
    audio_seconds = 0.0
    started_at = time.perf_counter()
    for index, example in enumerate(examples, start=1):
        encoded = example["audio"]["bytes"]
        if not encoded:
            raise ValueError("CoVoST example has no embedded audio bytes")
        samples = decode_audio_bytes(encoded, sample_rate)
        inputs = processor(samples, sampling_rate=sample_rate, return_tensors="pt")
        inputs = {
            key: value.to(device=arguments.device, dtype=dtype) if torch.is_floating_point(value) else value.to(arguments.device)
            for key, value in inputs.items()
        }
        with torch.inference_mode():
            generated = model.generate(
                input_features=inputs["input_features"],
                attention_mask=inputs["attention_mask"],
                max_new_tokens=arguments.max_new_tokens,
                num_beams=arguments.num_beams,
            )
        hypothesis = processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
        sources.append(str(example[arguments.source_field]).strip())
        references.append(str(example[arguments.reference_field]).strip())
        hypotheses.append(hypothesis)
        audio_seconds += len(samples) / sample_rate
        if index % 100 == 0:
            elapsed = time.perf_counter() - started_at
            print(f"processed={index} audio_seconds={audio_seconds:.2f} elapsed_seconds={elapsed:.2f}", flush=True)

    elapsed_seconds = time.perf_counter() - started_at
    scores = score_translations(references, hypotheses)
    comet_score = (
        score_comet(
            sources,
            references,
            hypotheses,
            arguments.comet_model,
            arguments.device,
            arguments.comet_batch_size,
        )
        if arguments.comet_model
        else None
    )
    result = {
        "dataset": arguments.dataset,
        "config": arguments.config,
        "split": arguments.split,
        "reference_field": arguments.reference_field,
        "source_field": arguments.source_field,
        "evaluation_scope": "full public split" if arguments.limit is None else f"first {len(references)} examples of the public split",
        "partial": arguments.limit is not None,
        "dataset_provenance": "Public CoVoST 2 parquet mirror with Common Voice audio and CoVoST translations",
        "model": arguments.model,
        "device": arguments.device,
        "compute_type": arguments.compute_type,
        "sample_rate": sample_rate,
        "examples": len(references),
        "bleu": scores["bleu"],
        "chrf": scores["chrf"],
        "comet_model": arguments.comet_model,
        "comet": comet_score,
        "audio_seconds": audio_seconds,
        "elapsed_seconds": elapsed_seconds,
        "rtf": elapsed_seconds / audio_seconds if audio_seconds else None,
        "hardware": {"cuda": torch.cuda.get_device_name(0) if arguments.device == "cuda" else None},
        "command": " ".join(sys.argv),
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
