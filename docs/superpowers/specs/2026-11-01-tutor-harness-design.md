# Tutor harness and teaching prompts (slice 1)

## Context

StudentLLM aims to help a student learn, understand and practise a course with a tutor that adapts to them. The work is split into four slices, each with its own spec, plan and independently reviewed PR:

1. **Tutor harness and prompts** (this document).
2. Interactive study materials: quiz sessions, flashcards, mind map, revision sheet, summary.
3. Learner profile and memory managed by the student.
4. Adaptation: mastery tracking and spaced review.

### Problems this slice addresses

- Chat makes one call that returns the whole lesson in a JSON `sections` envelope. One bad escape loses the answer, and long lessons reach the 120 s limit (`docs/teaching-visuals.md`, `model-comparison-2026-11-01*`).
- A prompt-only change is not enough. In the 2026-11-01 pilot, one sample per cell, a rewritten visuals prompt did not produce more complete widgets, and it did worse on Super VL. Treat this as exploratory evidence, not a measured effect.
- Rendering validity says nothing about correctness: models have produced valid widgets with wrong prose tables and wrong quiz keys.
- One 42-line reference covers all four widget types and is loaded for every question. It tells the model not to decorate, but gives it little guidance on when a visual is expected.
- The chat prompt has no explicit teaching behaviour per learner intent.

### Design references

Reference prompt documents kept outside the repository inspire the structure and techniques used here: ordered decision checklists, routing on the request's verb, modules loaded on demand, complexity budgets, failure-first guidance, wrong/right pairs and intent-based teaching. All text is written for StudentLLM with its own examples. Nothing is copied verbatim, and `src/prompts/README.md` keeps its rule against vendor identities and fictitious tools.

## Goals

- Every production prompt meets one written quality standard (see "Prompt standard"), not only the tutor and visual prompts.
- A failed visual never loses the explanation.
- Each visual type gets detailed guidance without inflating every chat request.
- Generated visuals are checked locally for syntax and for agreement with what the tutor asked for.
- The tutor uses visuals when they help, and does not use them for simple definitions.
- The tutor teaches according to intent: answer, diagnose, guide or go straight to the point.
- The new pipeline replaces the old one only if a prospective benchmark supports it.

## Non-goals

- New widget types, including steppers, comparisons and timelines. They arrive with slice 2.
- Changes to the Study tab's interface, learner profile, persistent memory, mastery or spaced review. The Study prompt text is in scope, its renderers are not.
- Proving mathematical correctness. Local checks detect contradictions only.
- Changing the saved or default model. That stays the user's decision, informed by the benchmark.
- Token streaming. Text appears when the tutor call completes.

## Architecture

```text
question -> buildChatContext -> tutor call (Markdown, no response_format)
         -> save prose with student-visual-request fences, show placeholders
         -> for each request, at most 4, 2 at a time:
              visual call (type module + strict schema)
              -> diagnose + semantic checks
              -> on failure, one repair call with the exact errors
              -> replace the fence with student-visual, or keep it for manual retry
```

### Units

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `src/lib/visual-brief.ts` | Parse and validate `student-visual-request` fences through the Markdown AST; replace one fence by id | `mdast-util-from-markdown` |
| `src/lib/teaching-visuals.ts` | Add `diagnoseTeachingVisual`, returning a visual or precise errors. `parseTeachingVisual` keeps its signature and delegates to it | none |
| `src/lib/visual-checks.ts` | `checkVisualAgainstBrief(visual, brief)` returns semantic errors | `teaching-visuals` |
| `src/lib/teaching-schemas.ts` | One strict JSON schema per visual type, extracted from `teaching-answer.ts` | none |
| `src/lib/teaching-generation.ts` | Orchestrate the tutor call, visual calls, repair, limits and progress callbacks | all of the above, `llm-provider` |
| `src/prompts/tutor.ts` | Teaching behaviour, tone, provenance | none |
| `src/prompts/visual-routing.ts` | When to request a visual and how to write the request | none |
| `src/prompts/visuals/{plot,diagram,figure,quiz}.ts` | One complete module per type | none |
| `benchmarks/tutor/` | Cases, runner and evaluator for both pipelines | source modules, real provider |

`App.tsx` owns persistence and progress state. `rich-text.tsx` renders placeholders and the retry action. `chat-context.ts` compacts visuals in history.

### Request fence

The tutor writes a fenced block with the language `student-visual-request`:

```json
{
  "id": "v1",
  "type": "plot",
  "intent": "Show how the degree changes the approximation near the centre",
  "content": "f(x)=cos(x), centred at 0, x from -6 to 6, slider for the degree from 0 to 12",
  "parameters": ["n"],
  "outputs": ["Error at x=1"],
  "checks": [{ "output": "Error at x=1", "at": { "n": 2 }, "expected": 0.0403, "tolerance": 0.001 }]
}
```

Fields: `id` (unique within the answer), `type` (`plot`, `diagram`, `figure`, `quiz`), `intent` (at most 300 characters), `content` (at most 1500 characters).

Optional fields:

- `parameters`: identifier names a plot must declare.
- `outputs`: readout labels a plot must contain exactly.
- `checks`: numeric anchors for a named output at given parameter values.
- `nodes`: labels a diagram must contain.
- `correctAnswer`: the exact text of the correct quiz option.

Only top-level fences in assistant messages count. Other positions are demoted to inert text with the existing AST logic, and user or imported content stays inert.

### Visual call

- System message: the type module.
- User message: JSON data with the brief and the prose section surrounding the fence, passed through the existing image redaction when the provider requires it. The full course is not resent, so visual calls stay short and evidence stays out of them.
- `response_format`: the type's strict schema when the provider supports structured outputs. Otherwise the reply is parsed as text with an optional code fence stripped.
- Output budget: at most 4096 tokens.

### Validation

`diagnoseTeachingVisual` reports errors such as `edge 3: "to" names unknown node "ss"` or `parameter n: value 3.5 is not min + k*step`. `checkVisualAgainstBrief` reports:

- a type different from the brief's type;
- a missing parameter, output or node named in the brief;
- a series with no finite value at the default parameters, sampled the way the renderer samples;
- duplicate quiz options;
- `correctAnswer` not matching the keyed option;
- a `checks` value outside its tolerance, evaluated with `compileExpression`.

### Repair

At most one repair call per visual. It receives the type module, the brief, the invalid output and the error list, and it asks for a complete corrected object. If the repair output still fails, the fence stays in the message. The previous documented rule, "no automatic repair generation", is replaced deliberately, and `docs/teaching-visuals.md` is updated.

### Limits

- At most 4 visual jobs per answer run automatically, in reading order. Further requests stay as retryable placeholders, so no call is spent unasked.
- 2 visual calls at a time.
- Hosted NVIDIA: a 60 s deadline per visual attempt, enforced with an `AbortSignal`.
- Local providers: the existing provider timeout applies, because a local CPU model cannot meet 60 s.
- The tutor call keeps its current token budget and failure behaviour.

### Tolerated deviations

A model that writes a direct `student-visual` fence instead of a request is handled without an extra call when the object validates. If it is invalid, the raw object becomes the input of one repair call with a brief derived from its type.

## Data flow and persistence

- The assistant message is saved as soon as the tutor call returns, with its request fences.
- A finished job replaces its fence with a canonical `student-visual` fence in the message, addressed by course id, message id and brief id. Saved answers therefore keep today's format, and export, reload and old history are unchanged.
- Which jobs are running is in-memory state. A request fence with no running job renders as "not generated" with **Retry this visual**. This single rule covers failed jobs, requests over the limit and an app closed mid-job. Errors are not persisted.
- Jobs continue if the student switches course. A job whose course or message no longer exists discards its result.
- In `chat-context.ts`, a visual in history becomes a compact record with its type, title, expressions and parameters. It remains usable for follow-ups such as "same thing with degree 5", without replaying full JSON or teaching the model to copy it. Saved history is unchanged. A pending request fence is compacted to its intent.

## Prompt standard

Every production prompt in `src/prompts/` follows this standard, written into `src/prompts/README.md`. It applies to the tutor, routing and type modules, and also to `study`, `context-data`, `conversation-memory`, `transcript-notes`, `document-notes`, `document-transcription`, `organization` and `course-detection`. Exact health-check phrases in `probes.json` are excluded.

1. **Opening:** one to three sentences stating the role, who it serves and what success looks like.
2. **Stable order:** purpose, inputs and trust, decision steps, output contract, frequent failures, examples, final check. A section is omitted only when it has nothing to say.
3. **Decisions as ordered steps** that stop at the first match, rather than loose lists of considerations.
4. **Rules with reasons:** a direct instruction, plus the reason when it is not obvious, so the model can apply it to unseen cases.
5. **Numbers for limits:** hard limits are stated as numbers, never as "keep it short".
6. **Failures first:** the failures observed in testing come before the general reference.
7. **Tagged examples:** `<example>` blocks with `<input>`, `<good_output>`, an optional `<bad_output>` and `<why>`. Each prompt has at least two, including one tricky case, except `context-data`, `conversation-memory` and `document-transcription`, which travel with every request or image and need one compact example. Example inputs use the format the app really sends.
8. **Checked examples:** JSON in an example is validated by tests against the real parser or by `JSON.parse`.
9. **Honest capabilities:** no vendor identity, no fictitious tools, no talk of internal machinery in user-facing output.
10. **Size budget:** the reference documents are long because they run on very large models. StudentLLM also runs on small local models, so quality comes from structure and examples, not length. Estimated with `estimateContextTokens`: tutor plus routing at most 6000, each type module at most 6000, other prompts at most 3000, and `context-data`, `conversation-memory` and `document-transcription` at most 450 each, because a longer note takes room from course evidence and memory on small windows.

The non-tutor prompts land in their own PR after the tutor PR. Faithful reconstruction prompts keep their existing guarantees: they must still refuse to add general knowledge or guess missing content.

## Prompts

All prompts are English instruction text, and the model answers in the learner's language. `chat.ts` becomes `tutor.ts`. `visuals.ts` and `structured-teaching.ts` are removed once the old pipeline is deleted.

### `tutor.ts`

- Purpose, then tone: warm and honest, no flattery, match effort to the request, at most one question per reply, and useful work before any question.
- Teaching by intent:
  - A direct question gets the answer first, with an optional check of understanding.
  - "I don't understand" gets a short diagnosis and a different angle, not the same explanation again.
  - An exercise gets hints and a next step before the solution, unless the learner asks for the correction.
  - Exam preparation favours retrieval practice.
  - An advanced or research-level question gets a direct technical answer without scaffolding.
- Provenance and technical precision rules carried over from `chat.ts`, including the rules against refusing general questions and against inventing citations or measurements.
- Formatting: minimal, and prose by default for explanations. Headings and lists appear only when the structure earns them.
- Worked behaviour examples as wrong/right pairs.

### `visual-routing.ts`

An ordered checklist that stops at the first match:

1. Would text alone be complete, such as a definition or a yes/no fact? Answer in prose.
2. Did the learner ask to see something, or name a visual artefact? Request it.
3. Does the concept have quantitative, sequential, spatial or structural behaviour that a learner benefits from seeing? Request a visual without being asked.
4. Would a practice question help now? Request a quiz.

It also defines:

- A routing table on the request's verb, for example "how does X change with Y" to a plot with a slider, "what are the steps" to a diagram, "sets or geometry" to a figure, and "test me" to a quiz.
- Budgets: usually one visual and at most four.
- Prose between visuals, and a statement of what to change or observe.
- Promise only what is requested: never announce a visual without its fence.
- Never expose machinery: no talk of requests, modules, schemas or checks.
- How to fill a request, including exact labels and numeric anchors.

### Type modules

Each module holds:

1. What the type is for and when another type is better.
2. The complete field and expression reference for that type.
3. The failures that cause most rejections for that type, listed first.
4. Wrong/right pairs.
5. Complete examples.
6. A final self-check.

The examples must not use any benchmark topic: Taylor series, the binomial law, half-life decay, sinusoidal voltage, or the new holdouts. The current prompt solves Taylor and binomial in its own examples, which would contaminate the measurement. Every JSON example is validated by the real parser in `prompts.test.ts`.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Tutor call fails or returns nothing | As today: alert, question returned to the composer, nothing saved |
| Malformed request fence | Treated as inert text, prose kept |
| Visual call fails, times out or returns invalid output | One repair call if there was an output to repair, otherwise retry placeholder. Prose kept |
| Student clicks retry | One new job with the same limits |
| Provider rate limit during visual jobs | Provider's existing single retry, then retry placeholder |
| Course or message removed during a job | Result discarded |

## Validation and promotion

The old pipeline stays reachable from the benchmark until the gate is decided. Before merging, either the new pipeline is the only one in the app and the old code is deleted, or the slice stops and the results go to the user.

### Benchmark

- Synthetic educational text only. The key comes from the process environment and is never logged. No private course data.
- Models: Lightning 30B, Super VL 120B, Mistral Large 4. Arms: old and new. Two samples per cell.
- Quality cases:
  - Taylor and binomial, used during prompt writing.
  - The two earlier holdouts, half-life and sinusoidal voltage. Their references were read while designing this slice, so they count as seen.
  - Two new holdouts written by an independent agent that does not see the new prompts. Their references stay hidden from the prompt author until the gate. Only these two are unseen.
- Rate cases, for the visual decision: 6 explanatory questions that should get a visual and 4 simple definitions that should not.
- Budget cap: 400 POST requests, without key rotation. Concurrency 2.
- Raw outputs are stored outside Git, with a summary in `docs/status.md`.

### Promotion criteria, fixed before running

1. More fully valid requested artefacts for the new pipeline than for the old one, in total, on the quality cases.
2. No model does worse overall on the new pipeline.
3. No new numeric error compared to the old arm, judged against the references, with quiz keys counted.
4. Visual requested on at least 80% of explanatory rate cases, and on at most 20% of definitions.
5. Time to first readable text no greater than the old arm's total time, per model, by median. Total time is reported.
6. `noMoreFailures`: no model has more failed new-arm rows than failed old-arm rows. A failed row is one where the learner got no usable answer (a rejected old envelope, a new reply with no answer, a call that hits the 120 s limit twice) and is a measurement: it is saved with its real elapsed time, counts as not complete and not requested, stays in both clocks at that time, and is never retried. A visual that fails its repair is not a failed row: the learner keeps the prose and a Retry button, and the missing artefact already counts against criterion 1.

A call that hits the 120 s limit is handled in two steps, because one stall must not decide the gate in either direction. The first time, its whole pair is discarded and rerun once after a 60 s wait, so the rerun is not inside the same outage (recorded in `failures.jsonl`, so the limit also holds across a resume; every POST counts against the ledger). A pair where both arms time out compares nothing and is not stored; three such or other failed pairs in a row stop that model for the process, the others continue, and the decision stays incomplete until a resume has measured it. A timeout in the rerun is a measurement, not a missing one: the learner would get an error there as well, and the app's proxy fails at the same point. It is recorded as a failed row with its real elapsed time and counted per arm. The criterion has no slack: with no failed old-arm row, one real failed new-arm row fails `noMoreFailures` for that model, and the decision goes to the human. Infrastructure failures (an HTTP error that outlives the provider's retry, a network error, the request cap, a reply that is not a completion) are not measurements: the pair is rerun, and the decision stays incomplete until every expected cell is measured. A run made on a dirty tree or with substitute cases never decides.

These are small exploratory samples. The result supports a decision and is not a statistical claim. A failed criterion stops the slice for diagnosis, and the metrics do not change after results are seen.

### Other prompts

The rewritten non-tutor prompts are compared with their current versions on real models with synthetic input: one transcript, one document, one organisation excerpt, one course detection and one request for each of the six study materials, on Lightning and Mistral Large 4, old and new. This is about 40 requests, counted inside the 400 cap. An independent agent reviews the outputs blind, without knowing which version produced which. A new prompt replaces the old one only if the review finds no new fabrication and at least the same coverage. Otherwise that prompt keeps its old version and the result is reported. `document-transcription` is not run, because that would mean adding an image path to the benchmark, so its new version is checked by tests only and reported as unmeasured.

### Tests

- Prompt standard: every prompt has at least the required number of tagged examples, respects its size budget and has parsable JSON examples.
- Unit: brief parsing and limits, diagnostics, every semantic check, orchestration with a fake provider (success, repair success, repair failure, tutor failure, abort, over-limit requests, direct valid and invalid fences, concurrency cap).
- Component: placeholder, retry, inert user fences, and existing renderer tests unchanged.
- App: progressive display, job completion after switching course, deleted course, reload with a pending fence.
- Context: compact visual records in history and follow-up continuity.
- Prompts: all examples parse, no benchmark topic in examples, no forbidden strings, routing text present.
- E2E: update `tests/e2e/teaching-visuals.spec.ts` for the two-step flow, including no extra requests on slider moves, plus CSP and axe. Python and desktop checks stay green through `npm run verify` and CI.
- Independent adversarial review on the PR, as required by the project rules.

## Risks

- **More calls and more total time.** An answer with 3 visuals costs at least 4 requests. Text comes first, and limits bound the cost. The benchmark reports the real numbers.
- **The tutor's anchors can be wrong.** A wrong `expected` value can trigger a needless repair, or make a correct visual fail and leave a retry placeholder. The benchmark counts these cases separately.
- **Local models.** Sequential local generation can be slow. The text-first flow reduces the impact, but this slice measures hosted models only, so local behaviour stays unmeasured.
- **Weak default model.** A better harness may not rescue a model that gets the mathematics wrong. The benchmark informs the separate model decision.
