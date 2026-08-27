# Benchmarks reproductibles

Ce dossier contient les adaptateurs et commandes de benchmark, pas les sorties brutes. Les artefacts locaux sont écrits sous `artifacts/` et ignorés par Git pour éviter de publier des prompts ou des données de benchmark inutilement.

## MMLU-Pro via LM Studio

`run_mmlu_pro.py` utilise le task public MMLU-Pro du projet [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness). L'adaptateur ajoute `/no_think` au dernier message utilisateur pour les modèles Qwen3 afin que le canal de réponse finale soit évalué au lieu du seul canal de raisonnement.

Préparer un environnement Python local:

```powershell
python -m venv .venv-bench
.\.venv-bench\Scripts\python.exe -m pip install "lm-eval[api]"
```

Le serveur LM Studio doit déjà être lancé et exposer le modèle demandé. La commande ci-dessous est un smoke de reproductibilité sur un item par catégorie, pas un score final:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=qwen/qwen3-4b,base_url=http://127.0.0.1:1234/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 1 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/qwen3-4b.json --log_samples
```

Pour toute publication, utiliser un split et une taille d'échantillon explicitement déclarés, conserver les sorties brutes localement et ne jamais transformer un run `--limit` en affirmation frontier.

## NVIDIA NIM

Le même adaptateur peut viser NVIDIA NIM sans placer la clé dans la ligne de commande:

```powershell
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
.\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 1 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/gpt-oss-20b.json --log_samples
```

Le run NVIDIA du 27 août 2026 a expiré sur le réseau après retries; il est conservé comme échec de transport, sans score. La clé reste lue au runtime depuis l'environnement utilisateur Windows.
