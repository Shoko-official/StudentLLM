# Course and conversation context

Application instructions live in `src/prompts/`. Chat and Study generate useful explanations even when no source matches. General knowledge and illustrative assumptions must remain distinct from course evidence; source-specific quotes, teacher claims and measurements must not be invented. OCR and faithful note reconstruction still preserve uncertainty in the original rather than guessing missing words.

## Selection and budgets

`buildChatContext` first tries all available text plus the complete dialogue. It reserves output tokens, schema/protocol tokens and 10% of the configured window. Its token counter is a conservative character-based heuristic, not the provider's tokenizer or a guaranteed bound. Settings can override the context allocation actually loaded by a local server. Known NVIDIA generation profiles use their documented 1,000,000-token maximum; other/local models default to 32,768 unless the provider advertises a window. These defaults do not prove the hosted trial or local runtime accepts that allocation. No million-token load test was run.

When necessary, older dialogue becomes locally extracted, role-labelled excerpts; recent complete turns and the exact current question are retained. Original saved history is unchanged. This memory is lossy and makes no extra model call. Sources, course metadata and memory are serialized user-level data, separate from trusted system instructions. Prior assistant messages are not established facts. This is an application implementation inspired by public context-management principles, not a reproduction of private ChatGPT or Claude internals or OpenAI encrypted Responses compaction.

Oversized text is split around paragraphs with overlap, headings and original source/line metadata. BM25 scans the corpus with French accent/plural and mathematical-symbol normalization. Optional semantic search contributes reciprocal-rank fusion, followed by duplicate reduction and adjacent passages to retain applicability conditions. Study explicitly requests distributed overview coverage. Retrieval has finite budgets and can miss relevant passages; provided-context links are not verified answer citations.

## Embeddings and privacy

NVIDIA mode uses `nvidia/nemotron-3.5-embed-1b`, separate `passage` and `query` input types, text modality, 512-dimensional float vectors, renormalization and `truncate: NONE`. Its browser route never contains the key and can only reach the fixed NVIDIA host. Text retrieval does not upload images; image transcription keeps its separate per-file opt-in, with local OCR as the default.

The application limits batches to 32 and semantic candidates to 512, sampled across the corpus plus lexical candidates. These are application limits, not claimed provider batch limits. Corpus vectors are cached in bounded browser memory by content and embedder/model identity; no database, local model download or vector persistence was added. A 60-second overall embedding deadline aborts the operation; per-request timeout is 15 seconds, starts are spaced 1.7 seconds apart, and quota/auth/network/invalid-response errors retain lexical retrieval without retries or key/model switching. Large corpora can therefore have partial semantic coverage. The app records no promise of complete retrieval or universal answer quality.

## Sources and verification

- [NVIDIA embedding API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-embed-1b-infer) and [model card](https://build.nvidia.com/nvidia/nemotron-3_5-embed-1b/modelcard): hosted parameters, input modes and model limits.
- [Lightning model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard) and [Mistral Large 4 model card](https://build.nvidia.com/mistralai/mistral-large-4-1t-a52b/modelcard): documented generation windows, not measured runtime allocations.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and [contextual retrieval](https://www.anthropic.com/news/contextual-retrieval): public principles informing selection and context metadata.
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction): a provider-specific Responses feature, not integrated with NIM here.

Synthetic tests cover full-course inclusion beyond the old first-12 cutoff, history/corrections, source trust boundaries, budgets, adjacent conditions, cache invalidation, fallback and actual cancellation. Real same-origin NVIDIA text probes verify the configured endpoint and modes, but a few educational paraphrases are not an independent retrieval benchmark. No private course material was used for those probes.
