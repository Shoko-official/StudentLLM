# Architecture StudentLLM

## Décision centrale

StudentLLM est organisé autour de trois couches qui ne doivent pas être confondues:

```text
Sources immuables
  audio, images, PDF, documents
          |
          v
Contenu dérivé traçable
  transcript, OCR, segments, embeddings
          |
          v
Contenu généré versionné
  cours, réponses, QCM, fiches, cartes
```

Une sortie générée peut être régénérée ou supprimée. Une source originale doit rester récupérable et son hash doit être vérifiable.

## Vertical slice actuelle

Le dépôt actuel expose une UI React + TypeScript qui sert de contrat d'expérience:

- navigation par matière et cours;
- création d'une session persistante au niveau UX;
- capture microphone navigateur facultative;
- transcript avec états `verified` et `review`;
- Studio d'artefacts;
- chat avec citations de contexte;
- provider smoke test indépendant de l'UI.

Les données sont encore en mémoire dans `src/App.tsx`. C'est intentionnel pour cette première tranche: le contrat d'interface peut être testé avant de figer le stockage natif.

## Cible technique

```text
React + TypeScript
  |-- Library / Course / Chat / Studio
  v
Tauri 2 + Rust
  |-- capture audio par chunks
  |-- SQLite WAL + migrations
  |-- file de jobs persistante
  |-- workers sidecar
        |-- SpeechEngine (whisper.cpp, NeMo, faster-whisper)
        |-- DocumentEngine (PDF, OCR, vision)
        |-- LLMProvider (LM Studio, NIM, vLLM)
  v
Knowledge store
  |-- SQLite + FTS5 pour la source de vérité
  |-- index vectoriel reconstructible
  |-- blobs filesystem avec checksum
```

## Contrats à préserver

### SpeechEngine

```ts
interface SpeechEngine {
  transcribeStream(input: AudioChunk): AsyncIterable<TranscriptEvent>;
  transcribeFile(input: AudioAsset): Promise<Transcript>;
  capabilities(): SpeechCapabilities;
}
```

Le modèle ne doit pas être codé en dur dans le domaine. Un moteur peut être CPU, Metal, CUDA ou distant selon le profil matériel et la préférence de confidentialité.

### LLMProvider

```ts
interface LLMProvider {
  models(): Promise<Model[]>;
  generate(request: GenerateRequest): AsyncIterable<GenerationEvent>;
}
```

L'agent loop reste possédée par l'application afin de contrôler scope, permissions, citations, logs et reproductibilité.

## Fiabilité et confidentialité

- écriture audio append-only par chunks;
- checksum sur les sources;
- SQLite WAL et migrations testées;
- reprise des jobs après arrêt;
- aucun appel réseau implicite en mode local;
- secrets dans le gestionnaire de credentials de l'OS ou dans l'environnement, jamais dans SQLite/logs;
- partage sans audio par défaut;
- suppression d'un cours propagée à la DB, aux blobs, index et caches.

Les points non implémentés ne sont pas présentés comme production-ready. Ils sont suivis par la feuille de route et les benchmarks.
