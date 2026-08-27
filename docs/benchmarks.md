# Benchmarks et gates de release

## Règle de preuve

Un test UI vert prouve un parcours d'interface. Il ne prouve pas la qualité ASR, OCR, RAG ou génération. StudentLLM publiera les résultats avec le dataset, la version du modèle, le matériel, la quantification, les seeds et la commande exacte.

Les benchmarks faciles ou auto-construits ne sont pas utilisés seuls pour déclarer une release frontier.

## Vérifications disponibles maintenant

| Vérification | Nature | Commande | Statut |
| --- | --- | --- | --- |
| TypeScript | gate locale | `npm run check` | PASS observé |
| UI integration | Vitest + Testing Library | `npm run test:run` | PASS observé, 6 tests |
| Production build | Vite | `npm run build` | PASS observé |
| Browser workflow | Playwright Chromium + axe | `npm run test:e2e` | PASS observé, 3 tests |
| NVIDIA generation | API réelle, clé runtime | `npm run providers:smoke` | PASS observé, 1,288 ms |
| LM Studio generation | serveur local réel | `npm run providers:smoke` | PASS observé, 351 ms |

Les latences ci-dessus sont des observations ponctuelles de la machine de développement, pas des SLO de production.

## Résultat public observé: MMLU-Pro

Le premier benchmark de génération utilise le harness officiel [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) et le dataset public [TIGER-Lab/MMLU-Pro](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro). Il passe par l'API OpenAI-compatible de LM Studio, sans clé distante.

| Run | Modèle / backend | Protocole | Résultat | Statut |
| --- | --- | --- | --- | --- |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test, 14 catégories, 1 item par catégorie, seed 42, `temperature=0`, `/no_think` | exact-match `0.2143` (3/14) | PASS technique, échantillon partiel |
| 2026-08-27 | `openai/gpt-oss-20b` / NVIDIA NIM | même protocole, clé issue de `NVIDIA_API_KEY` | timeout réseau avant la première réponse, aucun agrégat | network-failed, aucun score |

Ce score n'est pas un score leaderboard: le harness avertit lui-même que `--limit` ne doit pas servir à calculer une métrique finale. Il sert à vérifier la chaîne dataset -> prompt -> API -> extraction -> métrique. La force du modèle reste `strength-unverified`.

La passe élargie à 20 items par catégorie a été interrompue par le transport à 132/280 avant agrégation; elle est rejetée et aucun score n'en est déduit.

Reproduction:

```powershell
python -m venv .venv-bench
.\.venv-bench\Scripts\python.exe -m pip install "lm-eval[api]"
$env:PYTHONUTF8 = '1'
python benchmarks/run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=qwen/qwen3-4b,base_url=http://127.0.0.1:1234/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 1 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/qwen3-4b.json --log_samples
```

Les sorties brutes sont locales et ignorées par Git. Une exécution complète ou un run limité ne peut être promu sans conserver la commande, le commit, le dataset, le matériel et le statut de validité.

## Benchmarks publics à intégrer progressivement

| Domaine | Benchmark public | Mesures principales |
| --- | --- | --- |
| ASR multilingue | [FLEURS](https://huggingface.co/datasets/google/fleurs) | WER, CER |
| ASR français | [MLS](https://www.openslr.org/94/) | WER, terme technique |
| ASR français | [Common Voice](https://commonvoice.mozilla.org/datasets) | WER par accent/bruit |
| traduction | [CoVoST 2](https://github.com/facebookresearch/fairseq/tree/main/examples/speech_to_text) | BLEU, COMET |
| far-field | [AMI](https://groups.inf.ed.ac.uk/ami/corpus/) | WER, DER, SA-WER |
| bruit | [MUSAN](https://www.openslr.org/17/) | WER par SNR |
| diarisation | [DIHARD](https://dihardchallenge.github.io/dihard3/) | DER, JER |
| document parsing | [OmniDocBench](https://github.com/opendatalab/OmniDocBench) | TextEdit, TEDS, CDM |
| document QA | [DocVQA](https://www.docvqa.org/) | ANLS, exact match |
| tables | [PubTabNet](https://github.com/ibm-aur-nlp/PubTabNet) | TEDS |
| retrieval | [BEIR](https://github.com/beir-cellar/beir) | nDCG, Recall, MRR |
| embeddings | [MTEB](https://github.com/embeddings-benchmark/mteb) | scores par tâche/langue |
| tool calling | [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) | tool accuracy, AST |
| génération multi-domaine | [MMLU-Pro](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro) | exact-match par domaine |

## LectureBench

LectureBench est le benchmark produit versionné, pas un remplacement des jeux publics. Il contiendra:

- un golden set stable et rarement modifié;
- des données classroom avec français, anglais, code-switching, bruit, distance micro et parole superposée;
- documents avec pages, tableaux, formules, schémas et handwriting;
- questions RAG answerable et volontairement impossibles;
- citations exactes et timestamps de référence;
- tests de crash, reprise, export/import et suppression.

## Hard gates ciblés

Les seuils détaillés seront dans les manifests versionnés. Les premiers P0 sont:

```text
audio perdu = 0
source corrompue = 0
violation de scope = 0
trafic réseau inattendu en local-only = 0
erreur critique de formule sur golden set = 0
échec de migration = 0
échec de soak recording = 0
```

Les objectifs de calibration V1 incluent notamment WER classe normale <= 10 %, RTF < 1, RAG Recall@10 >= 98 %, faithfulness >= 98 %, précision des citations >= 99 % et exactitude QCM >= 99 %. Tant que les moteurs et les datasets ne sont pas intégrés, ces valeurs sont des objectifs, pas des résultats.

## Reproductibilité

Chaque résultat doit conserver:

- commit Git et version du manifest;
- dataset et split exact;
- modèle, backend et quantification;
- OS, CPU, RAM, GPU, VRAM, threads et mode énergie;
- seed et paramètres;
- métriques brutes et résumé;
- raison de promotion ou de rejet.

