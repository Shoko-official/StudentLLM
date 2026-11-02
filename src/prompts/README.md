# Application prompts

This is the single source directory for StudentLLM's production model instructions. Templates are readable multiline TypeScript strings shared by browser and Node runtimes without a raw-file loader; `index.ts` exports trimmed constants and builders for structured user-level data. Protocol schemas and validation remain in the code that enforces them, not in prose alone.

## Prompt standard

Every prompt here follows one standard, checked by `prompt-standard.test.ts`.

1. **Opening:** one to three sentences stating the role, who it serves and what success looks like.
2. **Stable order:** purpose, inputs and trust, decision steps, output contract, frequent failures, examples, final check. Omit a section only when it has nothing to say.
3. **Decisions as ordered steps** that stop at the first match, rather than loose lists of considerations.
4. **Rules with reasons:** a direct instruction, plus the reason when it is not obvious, so the model can apply it to unseen cases.
5. **Numbers for limits**, never "keep it short".
6. **Failures first:** failures observed in testing come before the general reference. Add new ones as they are observed.
7. **Tagged examples:** `<example>` with `<input>`, `<good_output>`, an optional `<bad_output>` and `<why>`. At least two, including a tricky case. `context-data`, `conversation-memory` and `document-transcription` travel with every request or image, so one compact example is enough. Example inputs use the format the app really sends.
8. **Checked examples:** JSON in an example is validated by a test against the real parser or `JSON.parse`.
9. **Honest capabilities:** no vendor identity, no fictitious tools, no talk of internal machinery in user-facing output.
10. **Size budget:** tutor plus routing at most 7200 estimated tokens, each type module at most 6000, the visual decision prompt at most 3700, other prompts at most 3000, and `context-data`, `conversation-memory` and `document-transcription` at most 450 each. StudentLLM runs on small local models too: quality comes from structure and examples, not length, and a longer note takes room from course evidence and memory.

Examples must never use a topic from `benchmarks/tutor/`, because that would contaminate the measurement.

| File | Purpose |
| --- | --- |
| `chat.ts` | Educational chat, useful answers with missing evidence, provenance and technical checks |
| `study.ts` | Study aids and their source-linked legacy visual format |
| `visuals.ts` | Actual plot/diagram/figure/quiz capabilities, examples, limits and consistency checks |
| `tutor-length-reminder.ts` | Short note sent as the last message of every tutor answer call, never saved or shown, because the system prompt alone did not control the length of answers |
| `visual-decision.ts` | One-shot decision, after a tutor answer without a visual, on whether to request one and what it contains |
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
