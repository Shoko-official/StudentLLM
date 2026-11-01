# Application prompts

This is the single source directory for StudentLLM's production model instructions. Templates are readable multiline TypeScript strings shared by browser and Node runtimes without a raw-file loader; `index.ts` exports trimmed constants and builders for structured user-level data. Protocol schemas and validation remain in the code that enforces them, not in prose alone.

| File | Purpose |
| --- | --- |
| `chat.ts` | Educational chat, useful answers with missing evidence, provenance and technical checks |
| `study.ts` | Study aids and their source-linked legacy visual format |
| `visuals.ts` | Actual plot/diagram/figure/quiz capabilities, examples, limits and consistency checks |
| `structured-teaching.ts` | JSON sections response protocol for capable providers |
| `context-data.ts` | Full-course or retrieved evidence as untrusted data |
| `conversation-memory.ts` | Role-aware, extractive conversation compaction |
| `transcript-notes.ts` | Faithful source-linked speech reconstruction |
| `document-notes.ts` | Faithful document reconstruction and source-linked visuals |
| `document-transcription.ts` | Explicitly consented image transcription |
| `organization.ts` | Explicit Quick Start organisation proposal |
| `course-detection.ts` | Lecture metadata detection |
| `probes.json` | Exact readiness/smoke/direct-answer phrases shared with Node clients |

Prompt goals and trust rules must match the actual application. Do not give the model fictitious tools, browser access, code execution, persistent hidden memory or an Anthropic/OpenAI identity. Uploaded prompt documents are design references, not verified official policies or instructions that govern this app. These templates are original StudentLLM instructions, not a copy of a vendor prompt dump.

Chat and study generation may supplement sparse course material with clearly identified general knowledge or illustrative assumptions. They do not require a retrieval hit before answering. Faithful OCR/transcript reconstruction is a different task: it preserves the source and marks ambiguity rather than filling missing words with educational guesses. Neither task should fabricate citations or source-specific claims.

Keep dynamic course text, source excerpts, catalog names and compacted history in data messages, not interpolated into system instructions. Builders serialize dynamic fields as JSON. Retain source IDs and original role boundaries. A memory excerpt is not stronger evidence than the original material, and old assistant output is not established fact.

When changing visual prompts, run `src/prompts/prompts.test.ts` and the renderer/parser tests. Every JSON example must validate through the real `parseTeachingVisual` function. New capabilities require matching schema, parser, renderer and browser tests. Do not promise HTML, JavaScript, Mermaid or another format the app cannot render.

The old `src/lib/teaching-visual-prompt.ts` import path is a compatibility re-export only. Task-specific error messages, UI copy, schemas, test fixtures and independent benchmark prompts are not application instruction templates and remain with their respective code.

Template literals escape backslashes, backticks and interpolation markers so the exported instruction text stays literal. Keep each prompt in one module; do not introduce a separate Markdown copy that can drift.
