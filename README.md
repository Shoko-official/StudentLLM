# StudentLLM

StudentLLM est un learning studio local-first pour transformer les cours en connaissances vérifiables. L'interface relie une session de cours, son transcript, ses sources et ses artefacts de révision sans remplacer la source originale.

> Statut: vertical slice frontend fonctionnelle. La capture microphone navigateur, la navigation de cours, le chat local simulé et le Studio sont testables. Les workers ASR, OCR, stockage persistant et RAG de production restent à intégrer derrière des interfaces stables.

## Ce qui est déjà livré

- Interface trois panneaux responsive: bibliothèque, cours/chat, Studio.
- Session de cours avec état d'enregistrement, compteur, marque-page et transcript à vérifier.
- Création d'un nouveau cours via le bouton ou `Ctrl/Cmd + N`.
- Recherche dans la bibliothèque et navigation entre cours.
- Sources du cours et artefacts de révision: résumé, fiche, QCM, flashcards, carte conceptuelle, glossaire.
- Chat avec citations de contexte visibles.
- Accès microphone via `getUserMedia` quand le navigateur l'autorise, avec mode démonstration sinon.
- Smoke test réel de NVIDIA NIM et LM Studio via APIs OpenAI-compatible.
- Tests unitaires/intégration Vitest et tests E2E Playwright.

## Principes du produit

1. Les sources originales sont la vérité: audio, documents et images ne sont jamais remplacés par du contenu généré.
2. Toute sortie générée doit pouvoir pointer vers une source, une page ou un timestamp.
3. Le local-first est le comportement par défaut; une requête distante doit être explicite.
4. Les moteurs IA sont interchangeables: LM Studio, NVIDIA NIM, vLLM et les futurs backends ne doivent pas contaminer le modèle métier.
5. La fiabilité prime sur un score IA isolé: aucune perte, corruption ou fuite réseau implicite.

## Démarrage rapide

Pré-requis: Node.js 22+ et npm 10+.

```bash
npm ci
npm run dev
```

Puis ouvrir l'URL affichée par Vite. Pour une prévisualisation de production:

```bash
npm run build
npm run preview
```

## Vérifications

```bash
npm run check
npm run test:run
npm run build
npm run test:e2e
```

Le test E2E installe/utilise Chromium via Playwright. Le smoke provider est volontairement manuel car il consomme des APIs et des ressources locales:

```bash
npm run providers:smoke
```

## Providers locaux et NVIDIA

Les credentials ne sont pas lus depuis un fichier du dépôt.

- NVIDIA: la variable `NVIDIA_API_KEY` est lue au runtime depuis l'environnement Windows utilisateur ou processus.
- LM Studio: serveur local par défaut sur `http://127.0.0.1:1234/v1`.
- Variables optionnelles: voir [.env.example](./.env.example). Ce fichier ne contient aucune valeur secrète.

Le smoke test masque la clé et n'affiche que le nom du modèle, la latence et un court échantillon de réponse. Voir [docs/providers.md](./docs/providers.md).

## Organisation

```text
src/
  App.tsx              UI et flux de la vertical slice
  styles.css           système visuel responsive
  types.ts             contrats de données frontend
  lib/recorder.ts      accès microphone isolé
  App.test.tsx         tests UI Vitest
scripts/
  provider-smoke.mjs   vérification NVIDIA + LM Studio
benchmarks/
  run_mmlu_pro.py      adaptateur lm-evaluation-harness pour MMLU-Pro
tests/e2e/
  workspace.spec.ts    parcours navigateur réel
docs/
  architecture.md     modèle cible et limites actuelles
  benchmarks.md       résultats observés, benchmarks publics et gates
  providers.md        configuration sans secret dans le repo
```

## Feuille de route

- Persistance SQLite WAL, chunks audio et reprise après crash.
- Abstractions `SpeechEngine` et `LLMProvider` côté Rust/sidecars.
- Import PDF/images, OCR et provenance par page/région.
- Retrieval hybride BM25 + dense + reranker, puis agent loop contrôlée par l'application.
- Tauri 2 après validation de la vertical slice web sur Windows, macOS et Linux.
- LectureBench et intégration progressive des jeux de données publics documentés dans [docs/benchmarks.md](./docs/benchmarks.md).

## Contribuer

Lire [CONTRIBUTING.md](./CONTRIBUTING.md). Les changements passent par une branche de travail, des commits ciblés, les gates locales et une PR mergée en squash après CI verte.

## Sécurité

Ne commitez jamais de clé NVIDIA, token, fichier `.env`, audio de cours ou document étudiant. Lire [SECURITY.md](./SECURITY.md).

## Licence

MIT. Voir [LICENSE](./LICENSE).
