#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="${HUMANEVAL_VENV:-/root/studentllm-human-eval}"
output_dir="$repo_dir/artifacts/benchmarks/humaneval"

if [[ ! -x "$venv_dir/bin/python" ]]; then
  python3 -m venv "$venv_dir"
  "$venv_dir/bin/python" -m pip install -r "$repo_dir/requirements-humaneval.txt"
fi

nvidia_api_key="$(powershell.exe -NoProfile -Command '[Environment]::GetEnvironmentVariable("NVIDIA_API_KEY","User")' | tr -d '\r')"
if [[ -z "$nvidia_api_key" ]]; then
  echo "NVIDIA_API_KEY is not available in the Windows User environment." >&2
  exit 1
fi

export NVIDIA_API_KEY="$nvidia_api_key"
export OPENAI_API_KEY="$nvidia_api_key"
export HF_ALLOW_CODE_EVAL=1
export PYTHONUTF8=1

concurrency="${HUMANEVAL_CONCURRENCY:-4}"
task_name="humaneval_instruct"
probe=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --probe)
      probe=true
      shift
      ;;
    --task)
      if [[ $# -lt 2 ]]; then
        echo "Usage: bash benchmarks/run_humaneval_wsl.sh [--probe] [--task humaneval|humaneval_instruct]" >&2
        exit 2
      fi
      task_name="$2"
      shift 2
      ;;
    *)
      echo "Usage: bash benchmarks/run_humaneval_wsl.sh [--probe] [--task humaneval|humaneval_instruct]" >&2
      exit 2
      ;;
  esac
done

if [[ "$task_name" != "humaneval" && "$task_name" != "humaneval_instruct" ]]; then
  echo "Unsupported HumanEval task: $task_name" >&2
  exit 2
fi

limit_args=()
output_name="gpt-oss-20b-nvidia-full.json"
if $probe; then
  limit_args=(--limit 1)
  output_name="gpt-oss-20b-nvidia-${task_name}-probe.json"
elif [[ "$task_name" == "humaneval" ]]; then
  output_name="gpt-oss-20b-nvidia-humaneval-full.json"
fi

mkdir -p "$output_dir"
"$venv_dir/bin/python" -m lm_eval run \
  --model local-chat-completions \
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=$concurrency,max_retries=3" \
  --tasks "$task_name" \
  --num_fewshot 0 --batch_size 1 --apply_chat_template \
  --confirm_run_unsafe_code \
  --gen_kwargs "temperature=0,max_gen_toks=1024,reasoning_effort=low,until=None" \
  --seed 42 \
  --output_path "$output_dir/$output_name" \
  --log_samples \
  "${limit_args[@]}"
