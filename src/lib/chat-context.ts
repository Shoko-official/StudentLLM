import type { ChatMessage } from '../types';
import type { ProviderMessage } from './llm-provider';
import { redactContextImages } from './context-text';
import { CONTEXT_DATA_INSTRUCTIONS, CONVERSATION_MEMORY_INSTRUCTIONS } from '../prompts';
import { retrievalTerms, searchDocuments, searchDocumentsHybrid, SEMANTIC_CANDIDATE_LIMIT, type RetrievalDocument, type RetrievalEmbedder } from './local-retrieval';

export interface ChatContextInput {
  documents: RetrievalDocument[];
  history: ChatMessage[];
  question: string;
  systemPrompt: string;
  course?: { title: string; subject: string; chapter: string };
  purpose?: 'question' | 'overview';
  redactImages?: boolean;
  contextWindowTokens: number;
  outputTokens: number;
  schemaTokens?: number;
  embedder?: RetrievalEmbedder | null;
  signal?: AbortSignal;
}
export interface ChatContextResult {
  messages: ProviderMessage[];
  evidence: RetrievalDocument[];
  mode: 'full' | 'retrieval' | 'general';
  estimatedInputTokens: number;
  compressedMessages: number;
  omittedDocumentCount: number;
  warnings: string[];
}

/** Conservative heuristic, not a model tokenizer or guaranteed token bound. */
export function estimateContextTokens(text: string) {
  let letters = 0, punctuation = 0, whitespace = 0, unicode = 0;
  const encoder = new TextEncoder();
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code > 127) unicode += encoder.encode(character).length;
    else if (/[A-Za-z0-9]/.test(character)) letters++;
    else if (/\s/.test(character)) whitespace++;
    else punctuation++;
  }
  return Math.ceil(letters / 3 + punctuation + whitespace / 3 + unicode);
}
export function estimateMessagesTokens(messages: ProviderMessage[]) {
  return messages.reduce((total, message) => total + estimateContextTokens(message.content) + 32, 0);
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Context request cancelled', 'AbortError'); }
function evidenceMessage(documents: RetrievalDocument[], complete: boolean, course?: ChatContextInput['course']): ProviderMessage | null {
  return documents.length || course ? { role: 'user', content: CONTEXT_DATA_INSTRUCTIONS + '\n' + JSON.stringify({ kind: 'course_evidence', coverage: documents.length ? complete ? 'complete_text' : 'retrieved_subset' : 'no_text', ...(course ? { course } : {}), documents }) } : null;
}
function memoryMessage(records: Array<{ id: string; role: string; excerpts: string[]; shortened: boolean }>): ProviderMessage | null {
  return records.length ? { role: 'user', content: CONVERSATION_MEMORY_INSTRUCTIONS + '\n' + JSON.stringify({ kind: 'extractive_conversation_memory', records }) } : null;
}
function packet(system: ProviderMessage, evidence: ProviderMessage | null, memory: ProviderMessage | null, history: ProviderMessage[], current: ProviderMessage) {
  return [system, ...(evidence ? [evidence] : []), ...(memory ? [memory] : []), ...history, current];
}
function historyTurns(history: ChatMessage[]) {
  const turns: ChatMessage[][] = [];
  for (const message of history) {
    if (message.role === 'user' || !turns.length) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  return turns;
}
function plain(message: ChatMessage): ProviderMessage { return { role: message.role, content: message.content }; }
function snippets(text: string, query: string, preferConstraints: boolean) {
  if (text.length <= 700) return [text];
  const terms = new Set(retrievalTerms(query));
  // Match locations matter: a correction can occur after a long paragraph of filler.
  const anchors: Array<{ index: number; score: number }> = [];
  if (preferConstraints) for (const match of text.matchAll(/\b(?:correction|corrige|rectification|rectifie|toujours|jamais|préfère|prefere|plutôt|plutot|utilise|garde|sans|do not|don't|always|never|prefer|instead|remember)\b/giu)) {
    anchors.push({ index: match.index!, score: /^(?:corr|rectif)/iu.test(match[0]) ? 100 : 80 });
  }
  for (const match of text.matchAll(/\S+/gu)) if (retrievalTerms(match[0]).some(term => terms.has(term))) anchors.push({ index: match.index!, score: 20 });
  if (anchors.length) {
    anchors.sort((a, b) => b.score - a.score || (a.score >= 80 ? b.index - a.index : a.index - b.index));
    const windows: Array<{ start: number; end: number }> = [];
    let remaining = 700;
    for (const anchor of anchors) {
      if (remaining < 80 || windows.some(window => anchor.index >= window.start && anchor.index < window.end)) continue;
      let start = Math.max(0, anchor.index - 100), end = Math.min(text.length, start + Math.min(400, remaining));
      while (start > 0 && start < anchor.index && !/\s/.test(text[start - 1])) start++;
      while (end < text.length && end > anchor.index + 40 && !/\s/.test(text[end])) end--;
      if (windows.some(window => start < window.end && end > window.start)) continue;
      windows.push({ start, end }); remaining -= end - start;
      if (windows.length === 3) break;
    }
    if (windows.length) return windows.sort((a, b) => a.start - b.start).map(window => text.slice(window.start, window.end));
  }
  const segments = text.split(/(?<=\n)|(?<=[.!?])(?=\s+[A-ZÀ-Ÿ])/u);
  const ranked = segments.map((value, index) => ({ value, index, score: retrievalTerms(value).filter(term => terms.has(term)).length + (preferConstraints && /\b(?:toujours|jamais|prefere|préfère|corrige|correction|plutôt|plutot|sans|do not|don't|always|never|prefer|instead|remember)\b/iu.test(value) ? 100 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked.slice(0, 3).sort((a, b) => a.index - b.index);
  let remaining = 700;
  return selected.flatMap(segment => {
    if (!remaining) return [];
    const value = segment.value.slice(0, remaining); remaining -= value.length;
    return [value];
  });
}
function makeMemory(history: ChatMessage[], question: string, tokenBudget: number) {
  if (tokenBudget <= 0 || !history.length) return null;
  const documents = history.map((message, index) => ({ id: String(index), text: message.content, metadata: { role: message.role } }));
  const relevant = searchDocuments(documents, question, 12).map(hit => Number(hit.document.id));
  const constraints = history.flatMap((message, index) => message.role === 'user' && /\b(?:toujours|jamais|prefere|préfère|corrige|correction|rectifi|plutôt|plutot|utilise|garde|sans|do not|don't|always|never|prefer|instead|remember)\b/iu.test(message.content) ? [index] : []).reverse();
  const candidates = [...new Set([...constraints.slice(0, 12), ...relevant, 0, history.length - 1])];
  const records: Array<{ id: string; role: string; excerpts: string[]; shortened: boolean }> = [];
  for (const index of candidates) {
    const message = history[index];
    const record = { id: message.id, role: message.role, excerpts: snippets(message.content, question, message.role === 'user'), shortened: message.content.length > 700 };
    const trial = [...records, record].sort((a, b) => history.findIndex(item => item.id === a.id) - history.findIndex(item => item.id === b.id));
    const memory = memoryMessage(trial)!;
    if (estimateMessagesTokens([memory]) <= tokenBudget) records.push(record);
  }
  return memoryMessage(records.sort((a, b) => history.findIndex(item => item.id === a.id) - history.findIndex(item => item.id === b.id)));
}

/** Retrieval-only splitting; originals and the full-context path remain unchanged. */
export function chunkContextDocuments(documents: RetrievalDocument[]): RetrievalDocument[] {
  return documents.flatMap(document => {
    if (document.text.length <= 1800) return [document];
    const text = document.text;
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const headings = Array.from(text.matchAll(/^#{1,6}\s+(.+)$/gm), match => ({ offset: match.index!, value: match[1].trim() }));
    const chunks: RetrievalDocument[] = [];
    let start = 0, headingIndex = -1;
    while (start < text.length) {
      let end = Math.min(text.length, start + 1800);
      if (end < text.length) {
        const paragraph = text.lastIndexOf('\n\n', end);
        const line = text.lastIndexOf('\n', end);
        if (paragraph > start + 900) end = paragraph;
        else if (line > start + 900) end = line;
      }
      while (headingIndex + 1 < headings.length && headings[headingIndex + 1].offset <= start) headingIndex++;
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (lineStarts[middle] <= start) low = middle; else high = middle; }
      const startLine = Math.max(1, Number(document.metadata.startLine) || 1) + low;
      chunks.push({ id: `${document.id}:context-${chunks.length + 1}`, text: text.slice(start, end), metadata: { ...document.metadata, contextDocumentId: document.id, parentId: document.metadata.parentId ?? document.id, startLine: String(startLine), ...(headingIndex < 0 ? {} : { heading: headings[headingIndex].value }) } });
      if (end === text.length) break;
      start = Math.max(start + 1, end - 180);
    }
    return chunks;
  });
}
function contextualQuery(question: string, history: ChatMessage[]) {
  if (!/\b(?:cela|ceci|ça|précédent|precedent|repren|encore|that|this|previous|again|it)\b/iu.test(question)) return question;
  const prior = history.filter(message => message.role === 'user').slice(-2).map(message => message.content.slice(0, 500));
  return [question, ...prior].join('\n');
}
function similarity(left: string, right: string) {
  const a = new Set(retrievalTerms(left)), b = new Set(retrievalTerms(right));
  let common = 0;
  for (const term of a) if (b.has(term)) common++;
  return common / Math.max(1, a.size + b.size - common);
}
function distributedOverview(chunks: RetrievalDocument[]) {
  const groups = new Map<string, RetrievalDocument[]>();
  for (const document of chunks) {
    const source = document.metadata.resourceId ?? document.metadata.resourceName ?? document.metadata.parentId ?? document.id;
    const group = groups.get(source) ?? []; group.push(document); groups.set(source, group);
  }
  const spread = <T,>(items: T[]) => {
    if (items.length <= 1) return items;
    const indices = [0, items.length - 1], ranges = [[0, items.length - 1]];
    for (let i = 0; i < ranges.length && indices.length < 64; i++) {
      const [left, right] = ranges[i], middle = Math.floor((left + right) / 2);
      if (middle <= left || middle >= right) continue;
      indices.push(middle); ranges.push([left, middle], [middle, right]);
    }
    return indices.map(index => items[index]);
  };
  const sources = [...groups.values()], ordered = spread(sources).map(spread);
  const documents: RetrievalDocument[] = [];
  for (let round = 0; documents.length < 64; round++) {
    let added = false;
    for (const source of ordered) if (source[round] && documents.length < 64) { documents.push(source[round]); added = true; }
    if (!added) break;
  }
  return { documents, sourceCount: groups.size };
}

export async function buildChatContext(input: ChatContextInput): Promise<ChatContextResult> {
  cancelled(input.signal);
  if (input.redactImages) input = {
    ...input,
    documents: input.documents.map(document => ({ ...document, text: redactContextImages(document.text), metadata: Object.fromEntries(Object.entries(document.metadata).map(([key, value]) => [key, redactContextImages(value)])) })),
    history: input.history.map(message => ({ ...message, content: redactContextImages(message.content) })),
    question: redactContextImages(input.question),
    course: input.course && { title: redactContextImages(input.course.title), subject: redactContextImages(input.course.subject), chapter: redactContextImages(input.course.chapter) },
  };
  const windowTokens = Math.floor(input.contextWindowTokens), outputTokens = Math.ceil(input.outputTokens), schemaTokens = Math.max(0, Math.ceil(input.schemaTokens ?? 0));
  if (!Number.isFinite(windowTokens) || !Number.isFinite(outputTokens) || windowTokens < 128 || outputTokens < 1 || !Number.isFinite(schemaTokens)) throw new Error('Configure a valid context window and output budget.');
  const reserve = Math.max(64, Math.ceil(windowTokens * .1));
  const capacity = windowTokens - reserve - outputTokens - schemaTokens;
  const system: ProviderMessage = { role: 'system', content: input.systemPrompt }, current: ProviderMessage = { role: 'user', content: input.question };
  const courseMetadata = evidenceMessage([], true, input.course);
  const required = estimateMessagesTokens(packet(system, courseMetadata, null, [], current));
  if (required > capacity) throw new Error('The question and instructions exceed the configured context budget. Shorten the question or increase the context window setting.');
  const documents = input.documents.filter(document => document.text.trim());
  const history = input.history.map(plain);
  const warnings = ['Context token counts are conservative estimates, not exact model tokenization.'];
  const result = (evidence: RetrievalDocument[], memory: ProviderMessage | null, kept: ProviderMessage[], complete: boolean): ChatContextResult => {
    const messages = packet(system, evidenceMessage(evidence, complete, input.course), memory, kept, current);
    const includedParents = new Set(evidence.map(document => document.metadata.contextDocumentId ?? document.id));
    return { messages, evidence, mode: complete && documents.length ? 'full' : documents.length ? 'retrieval' : 'general', estimatedInputTokens: estimateMessagesTokens(messages) + schemaTokens, compressedMessages: input.history.length - kept.length, omittedDocumentCount: documents.filter(document => !includedParents.has(document.id)).length, warnings };
  };
  // Estimate each entry separately first, avoiding a giant full-corpus JSON allocation when it cannot fit.
  const courseEstimate = documents.length ? documents.reduce((sum, document) => sum + estimateContextTokens(JSON.stringify(document)) + 2, courseMetadata ? 0 : estimateContextTokens(CONTEXT_DATA_INSTRUCTIONS) + 100) : 0;
  if (required + courseEstimate + estimateMessagesTokens(history) <= capacity) {
    const full = result(documents, null, history, true);
    if (full.estimatedInputTokens - schemaTokens <= capacity) return full;
  }
  let recent: ProviderMessage[] = [];
  const turns = historyTurns(input.history);
  const recentBudget = Math.floor((capacity - required) * .35);
  for (const turn of turns.slice(-4).reverse()) {
    const candidate = [...turn.map(plain), ...recent];
    const limit = recent.length ? recentBudget : Math.max(recentBudget, Math.floor((capacity - required) * .75));
    if (estimateMessagesTokens(candidate) > limit) break;
    recent = candidate;
  }
  const old = input.history.slice(0, input.history.length - recent.length);
  const memoryBudget = Math.min(2400, Math.floor((capacity - required - estimateMessagesTokens(recent)) * .25));
  const memory = makeMemory(old, input.question, memoryBudget);
  const base = estimateMessagesTokens(packet(system, courseMetadata, memory, recent, current));
  if (documents.length && base + courseEstimate <= capacity) {
    const full = result(documents, memory, recent, true);
    if (full.estimatedInputTokens - schemaTokens <= capacity) return full;
  }
  if (!documents.length) return result([], memory, recent, true);
  const chunks = chunkContextDocuments(documents);
  if (input.embedder && chunks.length > SEMANTIC_CANDIDATE_LIMIT) warnings.push(`Semantic candidate coverage is bounded to at most ${SEMANTIC_CANDIDATE_LIMIT} of ${chunks.length} chunks; lexical retrieval scans the complete corpus.`);
  const query = contextualQuery(input.question, input.history);
  let hits = await searchDocumentsHybrid(chunks, query, input.embedder, 64, { signal: input.signal, onDiagnostics: diagnostics => {
    if (input.embedder && diagnostics.fallback !== 'none') warnings.push(`Semantic retrieval ${diagnostics.fallback}; local lexical retrieval was retained.`);
  } });
  cancelled(input.signal);
  const overview = input.purpose === 'overview';
  if (overview) {
    const sample = distributedOverview(chunks);
    const combined = new Map<string, typeof hits[number]>();
    for (let index = 0; index < Math.max(hits.length, sample.documents.length); index++) {
      for (const candidate of [hits[index], sample.documents[index] && { document: sample.documents[index], matchedTerms: [] }]) {
        if (candidate && !combined.has(candidate.document.id)) combined.set(candidate.document.id, { ...candidate, score: 1 / (combined.size + 1) });
      }
    }
    hits = [...combined.values()];
    warnings.push(`Overview evidence uses a distributed sample of ${sample.documents.length} candidate chunks across ${sample.sourceCount} sources; coverage remains partial.`);
  }
  const selected: RetrievalDocument[] = [], used = new Set<string>();
  const positions = new Map(chunks.map((document, index) => [document.id, index]));
  const sourceKey = (document: RetrievalDocument) => document.metadata.resourceId ?? document.metadata.resourceName ?? document.metadata.parentId ?? '__course';
  const remaining = [...hits];
  while (remaining.length && selected.length < 64) {
    remaining.sort((a, b) => {
      const adjusted = (hit: typeof a) => hit.score * (1 - .7 * Math.max(0, ...selected.map(document => similarity(document.text, hit.document.text))));
      return adjusted(b) - adjusted(a);
    });
    const primary = remaining.shift()!.document;
    const position = positions.get(primary.id)!;
    for (const candidate of overview ? [primary] : [primary, chunks[position - 1], chunks[position + 1]]) {
      if (selected.length >= 64) break;
      if (!candidate || used.has(candidate.id) || sourceKey(candidate) !== sourceKey(primary)) continue;
      if (selected.some(document => document.text.trim() === candidate.text.trim())) { used.add(candidate.id); continue; }
      const trial = result([...selected, candidate], memory, recent, false);
      if (trial.estimatedInputTokens - schemaTokens <= capacity) { selected.push(candidate); used.add(candidate.id); }
    }
  }
  return result(selected, memory, recent, false);
}
