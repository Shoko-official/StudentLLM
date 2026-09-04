"""Run an OpenAI-compatible RAG system on the public CRAG Task 1/2 file.

Generation never receives the gold answer. The optional judge follows the
public CRAG evaluator's correct/missing/incorrect accounting and is reported
separately from deterministic text-match diagnostics.
"""

from __future__ import annotations

import argparse
import bz2
import html
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


TAG_PATTERN = re.compile(r"<[^>]+>")
SPACE_PATTERN = re.compile(r"\s+")


def normalize(value: str) -> str:
    value = html.unescape(value).lower()
    value = re.sub(r"[^\w\s]", " ", value, flags=re.UNICODE)
    return SPACE_PATTERN.sub(" ", value).strip()


def read_examples(path: Path, split: int, limit: int | None = None) -> list[dict[str, object]]:
    examples: list[dict[str, object]] = []
    with bz2.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            item = json.loads(line)
            if int(item["split"]) != split:
                continue
            examples.append(item)
            if limit is not None and len(examples) >= limit:
                break
    return examples


def page_text(page: dict[str, object], max_chars: int) -> str:
    snippet = str(page.get("page_snippet") or "")
    raw_result = str(page.get("page_result") or "")
    text = TAG_PATTERN.sub(" ", html.unescape(raw_result))
    text = SPACE_PATTERN.sub(" ", text).strip()
    return (snippet + "\n" + text[:max_chars]).strip()


def build_messages(item: dict[str, object], page_chars: int) -> list[dict[str, str]]:
    pages = item.get("search_results") or []
    evidence = []
    for index, page in enumerate(pages, start=1):
        evidence.append(f"[Source {index}] {page_text(page, page_chars)}")
    context = "\n\n".join(evidence)
    return [
        {
            "role": "system",
            "content": "Answer the user's question using only the supplied search evidence. Be concise, precise, and do not invent facts. If the evidence is insufficient, say I don't know.",
        },
        {"role": "user", "content": f"Question: {item['query']}\n\nSearch evidence:\n{context}\n/no_think"},
    ]


def make_client(base_url: str, api_key: str):
    from openai import OpenAI

    return OpenAI(base_url=base_url, api_key=api_key, max_retries=0, timeout=90.0)


def generate_one(item: dict[str, object], model: str, base_url: str, api_key: str, page_chars: int, max_tokens: int) -> str:
    client = make_client(base_url, api_key)
    response = client.chat.completions.create(
        model=model,
        messages=build_messages(item, page_chars),
        temperature=0.0,
        max_tokens=max_tokens,
    )
    return str(response.choices[0].message.content or "").strip()


def parse_judge(value: str) -> int:
    try:
        parsed = json.loads(value)
        score = int(parsed["score"])
        return score if score in {0, 1} else -1
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        match = re.search(r'"score"\s*:\s*([01])', value)
        return int(match.group(1)) if match else -1


def judge_one(question: str, gold_answers: list[str], prediction: str, model: str, base_url: str, api_key: str, max_tokens: int) -> int:
    if not prediction or "i don't know" in prediction.lower() or "i do not know" in prediction.lower():
        return 0
    client = make_client(base_url, api_key)
    ground_truth = "\n".join(gold_answers)
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "Judge whether the prediction correctly answers the question. Treat the ground truth as correct. Return JSON only: {\"score\": 1 or 0, \"explanation\": \"short reason\"}. Score 1 for an exact answer, a correct concise summary, or an equivalent rounded numeric answer; score 0 for omissions, contradictions, unsupported additions, or incorrect answers."},
            {"role": "user", "content": f"Question: {question}\nGround truth: {ground_truth}\nPrediction: {prediction}\n/no_think"},
        ],
        response_format={"type": "json_object"},
        temperature=0.0,
        max_tokens=max_tokens,
    )
    return parse_judge(str(response.choices[0].message.content or ""))


def run(path: Path, split: int, limit: int | None, model: str, base_url: str, api_key: str, workers: int, page_chars: int, max_tokens: int, judge_model: str | None, output_path: Path | None) -> dict[str, object]:
    if workers <= 0 or page_chars <= 0 or max_tokens <= 0:
        raise ValueError("workers, page_chars, and max_tokens must be positive")
    started_at = time.perf_counter()
    examples = read_examples(path, split, limit)
    records: list[dict[str, object]] = [{} for _ in examples]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(generate_one, item, model, base_url, api_key, page_chars, max_tokens): index for index, item in enumerate(examples)}
        for future in as_completed(futures):
            index = futures[future]
            item = examples[index]
            try:
                prediction = future.result()
                error = None
            except Exception as exc:  # Preserve failed public examples in the receipt.
                prediction = ""
                error = type(exc).__name__
            records[index] = {
                "interaction_id": item["interaction_id"],
                "query": item["query"],
                "domain": item["domain"],
                "question_type": item["question_type"],
                "prediction": prediction,
                "error": error,
                "gold_answers": [str(item["answer"])] + [str(answer) for answer in item.get("alt_ans", [])],
            }

    n_correct = 0
    n_missing = 0
    n_incorrect = 0
    judge_scores: list[int] = []
    if judge_model:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(judge_one, str(record["query"]), list(record["gold_answers"]), str(record["prediction"]), judge_model, base_url, api_key, max_tokens): index
                for index, record in enumerate(records)
            }
            for future in as_completed(futures):
                index = futures[future]
                try:
                    score = future.result()
                except Exception:
                    score = -1
                records[index]["judge_score"] = score
                judge_scores.append(score)
                if score == 1:
                    n_correct += 1
                elif not records[index]["prediction"] or "i don't know" in str(records[index]["prediction"]).lower() or "i do not know" in str(records[index]["prediction"]).lower():
                    n_missing += 1
                else:
                    n_incorrect += 1

    exact_matches = sum(any(normalize(str(record["prediction"])) == normalize(answer) for answer in record["gold_answers"]) for record in records)
    result: dict[str, object] = {
        "benchmark": "CRAG Task 1/2 development file",
        "source": "facebookresearch/CRAG",
        "dataset_path": str(path),
        "split": split,
        "limit": limit,
        "partial": limit is not None,
        "model": model,
        "judge_model": judge_model,
        "parameters": {"base_url": base_url, "workers": workers, "page_chars": page_chars, "max_tokens": max_tokens},
        "examples": len(records),
        "generation_failures": sum(record["error"] is not None for record in records),
        "deterministic_exact_match": exact_matches / len(records) if records else 0.0,
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
    }
    if judge_model:
        result["judge"] = {
            "scored": len(judge_scores),
            "unparsed": sum(score < 0 for score in judge_scores),
            "correct": n_correct,
            "missing": n_missing,
            "incorrect": n_incorrect,
            "score": (2 * n_correct + n_missing) / len(records) - 1 if records else 0.0,
        }
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps({"receipt": result, "records": records}, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a chat model on public CRAG Task 1/2 data.")
    parser.add_argument("--dataset-path", type=Path, required=True)
    parser.add_argument("--split", type=int, choices=(0, 1), default=0)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--model", default="openai/gpt-oss-20b")
    parser.add_argument("--judge-model")
    parser.add_argument("--base-url", default="https://integrate.api.nvidia.com/v1")
    parser.add_argument("--api-key-env", default="NVIDIA_API_KEY")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--page-chars", type=int, default=2000)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--output-path", type=Path)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        raise SystemExit("limit must be positive")
    import os

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    result = run(args.dataset_path, args.split, args.limit, args.model, args.base_url, api_key, args.workers, args.page_chars, args.max_tokens, args.judge_model, args.output_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
