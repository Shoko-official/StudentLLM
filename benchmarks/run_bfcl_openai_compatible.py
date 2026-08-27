"""Run the official BFCL generator and scorer against an OpenAI-compatible endpoint."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from types import SimpleNamespace


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run an official BFCL V4 category through an OpenAI-compatible endpoint."
    )
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--category", default="simple_python")
    parser.add_argument("--model", default="openai/gpt-oss-20b")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--api-key-env", default="NVIDIA_API_KEY")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--num-threads", type=int, default=1)
    parser.add_argument("--allow-overwrite", action="store_true")
    parser.add_argument("--include-input-log", action="store_true")
    parser.add_argument("--exclude-state-log", action="store_true")
    return parser.parse_args()


def configure_environment(args: argparse.Namespace, project_root: Path) -> None:
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise SystemExit(f"The API key environment variable {args.api_key_env!r} is not set.")

    os.environ["BFCL_PROJECT_ROOT"] = str(project_root)
    os.environ["OPENAI_BASE_URL"] = args.base_url.rstrip("/")
    os.environ["OPENAI_API_KEY"] = api_key
    os.environ["PYTHONUTF8"] = "1"


def register_endpoint_model(model: str) -> None:
    from bfcl_eval.constants.model_config import MODEL_CONFIG_MAPPING, ModelConfig
    from bfcl_eval.model_handler.api_inference.openai_completion import (
        OpenAICompletionsHandler,
    )

    MODEL_CONFIG_MAPPING[model] = ModelConfig(
        model_name=model,
        display_name=f"{model} via OpenAI-compatible endpoint",
        url=os.environ["OPENAI_BASE_URL"],
        org="OpenAI-compatible endpoint",
        license="Provider model license",
        model_handler=OpenAICompletionsHandler,
        is_fc_model=True,
        underscore_to_dot=False,
    )


def run(args: argparse.Namespace) -> None:
    if args.start < 0:
        raise SystemExit("--start must be non-negative.")
    if args.limit <= 0:
        raise SystemExit("--limit must be positive.")
    if args.num_threads <= 0:
        raise SystemExit("--num-threads must be positive.")

    project_root = args.project_root.resolve()
    project_root.mkdir(parents=True, exist_ok=True)
    configure_environment(args, project_root)
    test_ids = [f"{args.category}_{index}" for index in range(args.start, args.start + args.limit)]
    (project_root / "test_case_ids_to_generate.json").write_text(
        json.dumps({args.category: test_ids}, indent=2) + "\n",
        encoding="utf-8",
    )
    register_endpoint_model(args.model)

    from bfcl_eval._llm_response_generation import main as generation_main

    generation_main(
        SimpleNamespace(
            model=[args.model],
            test_category=[args.category],
            temperature=args.temperature,
            include_input_log=args.include_input_log,
            exclude_state_log=args.exclude_state_log,
            num_gpus=1,
            num_threads=args.num_threads,
            gpu_memory_utilization=0.9,
            backend="sglang",
            skip_server_setup=True,
            local_model_path=None,
            result_dir="result",
            allow_overwrite=args.allow_overwrite,
            run_ids=True,
            enable_lora=False,
            max_lora_rank=None,
            lora_modules=None,
        )
    )

    from bfcl_eval.eval_checker.eval_runner import main as evaluation_main

    evaluation_main([args.model], [args.category], "result", "score", True)
    print(
        json.dumps(
            {
                "benchmark": "BFCL V4",
                "model": args.model,
                "category": args.category,
                "case_count": len(test_ids),
                "first_case": test_ids[0],
                "last_case": test_ids[-1],
                "project_root": str(project_root),
                "result_dir": str(project_root / "result"),
                "score_dir": str(project_root / "score"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    run(parse_args())
