# Course note pipeline

StudentLLM keeps a course note readable while a lesson is being captured, then enriches the finalized note when a local model is available.

## Note lifecycle

1. Transcript segments are appended to the selected lesson and immediately produce a deterministic note.
2. Each segment keeps its timestamp, speaker, source resource, and review state.
3. The deterministic formatter extracts only evidence-shaped blocks: paragraphs, formulas, code, concept schemas, and numeric charts.
4. After an imported source, recording, transcription, OCR result, or Quick Start placement is finalized, the local provider may add richer annotations.
5. The formatted note is persisted with the lesson workspace and remains exportable as Markdown.

The live path never waits for the enrichment request. If the provider is unavailable, returns invalid JSON, returns an empty block list, or references a segment outside the supplied transcript, the deterministic note remains the saved result.

## Provider contract

The formatter sends a bounded, source-labelled transcript envelope to the configured OpenAI-compatible local provider. The request asks for strict JSON with this shape:

```json
{
  "blocks": [
    {
      "type": "formula | code | schema | chart",
      "sourceId": "transcript-segment-id"
    }
  ]
}
```

Each block type adds its own fields:

- `formula`: `latex` and an optional `caption`;
- `code`: `language` and `code`;
- `schema`: non-empty `nodes` and directed `edges` whose endpoints are present in `nodes`;
- `chart`: a `label` and at least two finite numeric `values`.

The application validates the response before rendering it. A block is accepted only when its `sourceId` belongs to the submitted transcript. This keeps formulas, snippets, relationships, and charts traceable to the lecture material instead of letting the model invent unsupported note content.

## Rendering

Course notes use a document-like layout:

- inline and display LaTeX are rendered with KaTeX and accessible MathML;
- code is shown in a labelled code block;
- schemas are rendered as compact directed relationships;
- charts use simple proportional bars and retain the original values;
- transcript paragraphs retain their timestamp and speaker metadata.

The note renderer accepts both transcript segment IDs and source resource IDs when joining an enriched block to its original paragraph. This matters for imported files, where the transcript segment ID is derived from the resource ID.

## Verification

The formatter is covered by unit and App integration tests for:

- strict JSON schema usage;
- formula, code, schema, and chart enrichment;
- invalid or unlinked model output fallback;
- source/resource ID joining;
- imported material routing and persisted rich blocks.

Run the focused checks with:

```bash
npx vitest run src/lib/course-notes.test.ts src/App.test.tsx
npm run check
```
