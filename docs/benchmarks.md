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
| Browser workflow | Playwright Chromium | `npm run test:e2e` | à exécuter dans CI/local |
| NVIDIA generation | API réelle, clé runtime | `npm run providers:smoke` | PASS observé, 1,288 ms |
| LM Studio generation | serveur local réel | `npm run providers:smoke` | PASS observé, 351 ms |

Les latences ci-dessus sont des observations ponctuelles de la machine de développement, pas des SLO de production.

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

