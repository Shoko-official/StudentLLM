#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="${EVALPLUS_VENV:-/root/studentllm-human-eval}"
output_dir="${EVALPLUS_ROOT:-$repo_dir/artifacts/benchmarks/humaneval-plus-code-only}"
parallel="${EVALPLUS_PARALLEL:-4}"
probe=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --probe)
      probe=true
      shift
      ;;
    *)
      echo "Usage: bash benchmarks/run_evalplus_wsl.sh [--probe]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$venv_dir/bin/python" ]]; then
  python3 -m venv "$venv_dir"
fi
if [[ ! -x "$venv_dir/bin/evalplus.evaluate" ]]; then
  "$venv_dir/bin/python" -m pip install -r "$repo_dir/requirements-evalplus.txt"
fi

nvidia_api_key="$(powershell.exe -NoProfile -Command '[Environment]::GetEnvironmentVariable("NVIDIA_API_KEY","User")' | tr -d '\r')"
if [[ -z "$nvidia_api_key" ]]; then
  echo "NVIDIA_API_KEY is not available in the Windows User environment." >&2
  exit 1
fi

export NVIDIA_API_KEY="$nvidia_api_key"
export OPENAI_API_KEY="$nvidia_api_key"
export PYTHONUTF8=1

run_root="$output_dir"
id_args=()
if $probe; then
  run_root="$output_dir/probe"
  id_args=(--limit 1)
fi

mkdir -p "$run_root"
sample_path="$run_root/samples_humaneval_evalplus.jsonl"
raw_sample_path="$run_root/samples_humaneval_evalplus.raw.jsonl"
"$venv_dir/bin/python" "$repo_dir/benchmarks/run_evalplus_nvidia.py" \
  --output "$sample_path" \
  --raw-output "$raw_sample_path" \
  --model openai/gpt-oss-20b \
  --base-url https://integrate.api.nvidia.com/v1 \
  "${id_args[@]}"

if [[ ! -f "$sample_path" ]]; then
  echo "EvalPlus did not create the expected sample file: $sample_path" >&2
  exit 1
fi

if $probe; then
  echo "EvalPlus generation probe completed: $sample_path"
  exit 0
fi

"$venv_dir/bin/evalplus.evaluate" humaneval \
  --samples "$sample_path" \
  --parallel "$parallel"
