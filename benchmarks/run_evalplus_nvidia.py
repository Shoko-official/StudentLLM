"""Generate EvalPlus HumanEval samples through an OpenAI-compatible endpoint."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from evalplus.data import get_human_eval_plus, get_mbpp_plus
from evalplus.sanitize import sanitize
from openai import APIConnectionError, APIError, OpenAI, RateLimitError


INSTRUCTION_PREFIX = (
    "Please provide a self-contained Python script that solves the following "
    "problem in a markdown code block:"
)
MODEL = "openai/gpt-oss-20b"
BASE_URL = "https://integrate.api.nvidia.com/v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=("humaneval", "mbpp"), default="humaneval")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-output", type=Path, required=True)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--reasoning-effort", default="low")
    parser.add_argument("--max-attempts", type=int, default=4)
    return parser.parse_args()


def load_completed(path: Path) -> set[str]:
    if not path.exists():
        return set()
    completed = set()
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                completed.add(json.loads(line)["task_id"])
    return completed


def request_completion(client: OpenAI, task_prompt: str, args: argparse.Namespace):
    message = f"{INSTRUCTION_PREFIX}\n```python\n{task_prompt.strip()}\n```"
    request = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant good at coding."},
            {"role": "user", "content": message},
        ],
        "max_tokens": args.max_tokens,
        "temperature": 0,
        "top_p": 0.95,
    }
    if args.reasoning_effort != "none":
        request["reasoning_effort"] = args.reasoning_effort

    for attempt in range(1, args.max_attempts + 1):
        try:
            response = client.chat.completions.create(**request)
            choice = response.choices[0]
            content = choice.message.content or ""
            reasoning_content = getattr(choice.message, "reasoning_content", None) or ""
            if not content and reasoning_content:
                content = reasoning_content
            return content, reasoning_content
        except (APIConnectionError, APIError, RateLimitError):
            if attempt == args.max_attempts:
                raise
            time.sleep(2**attempt)

    raise RuntimeError("No completion was returned")


def main() -> None:
    args = parse_args()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not available in the environment.")

    if args.dataset == "humaneval":
        dataset = list(get_human_eval_plus().items())
    else:
        dataset = list(get_mbpp_plus().items())
    if args.limit is not None:
        if args.limit < 1:
            raise SystemExit("--limit must be positive")
        dataset = dataset[: args.limit]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.raw_output.parent.mkdir(parents=True, exist_ok=True)
    completed = load_completed(args.output)
    client = OpenAI(api_key=api_key, base_url=args.base_url)

    with args.output.open("a", encoding="utf-8") as sanitized_handle, args.raw_output.open(
        "a", encoding="utf-8"
    ) as raw_handle:
        for task_id, problem in dataset:
            if task_id in completed:
                continue

            content, reasoning_content = request_completion(client, problem["prompt"], args)
            solution = sanitize(content, entrypoint=problem["entry_point"])
            sanitized_record = {"task_id": task_id, "solution": solution}
            raw_record = {
                "task_id": task_id,
                "content": content,
                "reasoning_content": reasoning_content,
                "content_present": bool(content),
            }
            sanitized_handle.write(json.dumps(sanitized_record, ensure_ascii=False) + "\n")
            sanitized_handle.flush()
            raw_handle.write(json.dumps(raw_record, ensure_ascii=False) + "\n")
            raw_handle.flush()
            completed.add(task_id)
            print(f"completed={len(completed)}/{len(dataset)} task={task_id}", flush=True)


if __name__ == "__main__":
    main()
