export interface RetrievalDocument { id: string; text: string; metadata: Record<string, string> }
export interface RetrievalHit { document: RetrievalDocument; score: number; matchedTerms: string[] }
export interface RetrievalEmbedder {
  embed: (inputs: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  embedQuery?: (input: string, options?: { signal?: AbortSignal }) => Promise<number[]>;
  embedDocuments?: (inputs: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  /** Include endpoint/model identity when wrappers are recreated. Never credentials or course text. */
  cacheKey?: string;
}
export const SEMANTIC_CANDIDATE_LIMIT = 512;
export interface RetrievalDiagnostics {
  semanticCandidates: number;
  indexedCandidates: number;
  semanticUsed: boolean;
  fallback: 'none' | 'not-configured' | 'invalid-response' | 'unavailable' | 'deadline';
}
const EMBEDDING_DEADLINE_MS = 60_000;
const stopWords = new Set(('a an and are as at be by can did do does for from how i in is it of on or that the this to was what when where which who why with '
  + 'au aux ce ces cet cette dans de des du elle en est et eux il ils je la le les leur lui ma mais me mes mon ne nos notre nous on ou par pour qu que quel quelle quelles quels qui se ses son sont sur ta te tes ton tu un une vos votre vous').split(' '));
const mathWords: Record<string, string> = { 'ρ': ' rho ', 'σ': ' sigma ', 'λ': ' lambda ', 'μ': ' mu ', '∇': ' gradient ', '∂': ' derivee partial ', '∑': ' somme sum ', 'Δ': ' delta ', 'π': ' pi ' };

export function retrievalTerms(value: string) {
  return value.replace(/[ρσλμ∇∂∑Δπ]/gu, symbol => mathWords[symbol])
    .toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u).filter(term => (term.length > 1 || /^[0-9xyz]$/.test(term)) && !stopWords.has(term))
    .map(term => term.length > 4 && /s$/.test(term) && !/ss$/.test(term) ? term.slice(0, -1) : term);
}
export function searchDocuments(documents: RetrievalDocument[], query: string, limit = 5): RetrievalHit[] {
  const queryTerms = [...new Set(retrievalTerms(query))];
  if (!queryTerms.length || !documents.length || limit <= 0) return [];
  const tokenized = documents.map(document => ({ document, terms: retrievalTerms([
    document.metadata.resourceName, document.metadata.heading, document.metadata.timestamp, document.metadata.speaker,
    document.metadata.part && `part ${document.metadata.part}`, document.metadata.page && `page ${document.metadata.page}`, document.text,
  ].filter(Boolean).join(' ')) }));
  const frequency = new Map<string, number>();
  for (const item of tokenized) for (const term of new Set(item.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const averageLength = tokenized.reduce((sum, item) => sum + item.terms.length, 0) / tokenized.length;
  return tokenized.map(({ document, terms }) => {
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    const matchedTerms = queryTerms.filter(term => counts.has(term));
    let score = matchedTerms.reduce((sum, term) => {
      const tf = counts.get(term)!;
      const idf = Math.log(1 + (documents.length - frequency.get(term)! + .5) / (frequency.get(term)! + .5));
      return sum + idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * terms.length / Math.max(averageLength, 1)));
    }, 0);
    if (queryTerms.length > 1 && terms.join(' ').includes(queryTerms.join(' '))) score *= 1.3;
    return { document, score, matchedTerms };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id)).slice(0, limit);
}
function cosine(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return null;
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) return null;
    dot += left[i] * right[i]; a += left[i] ** 2; b += right[i] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : null;
}
interface CachedVector { text: string; vector: number[] }
interface VectorCache { documents: Map<string, CachedVector>; queries: Map<string, number[]> }
const objectCaches = new WeakMap<RetrievalEmbedder, VectorCache>();
const namedCaches = new Map<string, VectorCache>();
function cacheFor(embedder: RetrievalEmbedder) {
  if (embedder.cacheKey) {
    let cache = namedCaches.get(embedder.cacheKey);
    if (!cache) { cache = { documents: new Map(), queries: new Map() }; namedCaches.set(embedder.cacheKey, cache); }
    else { namedCaches.delete(embedder.cacheKey); namedCaches.set(embedder.cacheKey, cache); }
    if (namedCaches.size > 4) namedCaches.delete(namedCaches.keys().next().value!);
    return cache;
  }
  let cache = objectCaches.get(embedder);
  if (!cache) { cache = { documents: new Map(), queries: new Map() }; objectCaches.set(embedder, cache); }
  return cache;
}
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}
function passage(document: RetrievalDocument) { return `${document.metadata.resourceName ?? ''}\n${document.metadata.heading ?? ''}\n${document.text}`; }
function validVector(value: unknown): value is number[] { return Array.isArray(value) && value.length > 0 && value.length <= 16_384 && value.every(n => typeof n === 'number' && Number.isFinite(n)) && value.some(n => n !== 0); }
function semanticCandidates(documents: RetrievalDocument[], lexical: RetrievalHit[]) {
  if (documents.length <= SEMANTIC_CANDIDATE_LIMIT) return documents;
  const chosen = new Map(lexical.slice(0, SEMANTIC_CANDIDATE_LIMIT / 2).map(hit => [hit.document.id, hit.document]));
  // Cover the corpus instead of using its prefix when query vocabulary differs.
  const slots = SEMANTIC_CANDIDATE_LIMIT - chosen.size;
  for (let i = 0; i < slots; i++) {
    const document = documents[Math.floor(i * (documents.length - 1) / Math.max(slots - 1, 1))];
    chosen.set(document.id, document);
  }
  return [...chosen.values()];
}
/** BM25 + reciprocal-rank fusion. Cached corpus vectors and separate query/passage modes. */
export async function searchDocumentsHybrid(documents: RetrievalDocument[], query: string, embedder: RetrievalEmbedder | null | undefined, limit = 5, options: { signal?: AbortSignal; onDiagnostics?: (diagnostics: RetrievalDiagnostics) => void } = {}): Promise<RetrievalHit[]> {
  if (options.signal?.aborted) throw new DOMException('Context request cancelled', 'AbortError');
  const lexical = searchDocuments(documents, query, Math.max(limit * 12, SEMANTIC_CANDIDATE_LIMIT / 2));
  if (!embedder || !documents.length || limit <= 0) {
    options.onDiagnostics?.({ semanticCandidates: 0, indexedCandidates: 0, semanticUsed: false, fallback: 'not-configured' });
    return lexical.slice(0, limit);
  }
  const cache = cacheFor(embedder);
  const candidates = semanticCandidates(documents, lexical);
  const diagnostics: RetrievalDiagnostics = { semanticCandidates: candidates.length, indexedCandidates: 0, semanticUsed: false, fallback: 'none' };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, EMBEDDING_DEADLINE_MS);
  const withinDeadline = async <T,>(work: Promise<T>): Promise<T> => {
    let onAbort = () => {};
    try { return await Promise.race([work, new Promise<never>((_, reject) => { onAbort = () => reject(new DOMException('Embedding cancelled', 'AbortError')); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); })]); }
    finally { controller.signal.removeEventListener('abort', onAbort); }
  };
  try {
    let queryVector = cache.queries.get(query);
    const missing = candidates.filter(document => {
      const stored = cache.documents.get(document.id);
      if (stored?.text !== passage(document)) return true;
      remember(cache.documents, document.id, stored, 1024); return false;
    });
    if (!queryVector) {
      if (controller.signal.aborted) throw new DOMException('Embedding cancelled', 'AbortError');
      const result = embedder.embedQuery ? await withinDeadline(embedder.embedQuery(query, { signal: controller.signal })) : (await withinDeadline(embedder.embed([query], { signal: controller.signal })))[0];
      if (!validVector(result)) { diagnostics.fallback = 'invalid-response'; return lexical.slice(0, limit); }
      queryVector = result.slice(); remember(cache.queries, query, queryVector, 64);
    }
    remember(cache.queries, query, queryVector, 64);
    for (let start = 0; start < missing.length; start += 32) {
      if (controller.signal.aborted) throw new DOMException('Embedding cancelled', 'AbortError');
      const batch = missing.slice(start, start + 32), input = batch.map(passage);
      const vectors = await withinDeadline(embedder.embedDocuments ? embedder.embedDocuments(input, { signal: controller.signal }) : embedder.embed(input, { signal: controller.signal }));
      if (vectors.length !== batch.length || vectors.some(vector => !validVector(vector) || vector.length !== queryVector.length)) { diagnostics.fallback = 'invalid-response'; cache.queries.delete(query); return lexical.slice(0, limit); }
      batch.forEach((document, i) => remember(cache.documents, document.id, { text: input[i], vector: vectors[i].slice() }, 1024));
    }
    const semantic = candidates.map(document => ({ document, similarity: cosine(queryVector!, cache.documents.get(document.id)?.vector ?? []) }))
      .filter((hit): hit is { document: RetrievalDocument; similarity: number } => hit.similarity !== null && Number.isFinite(hit.similarity))
      .sort((a, b) => b.similarity - a.similarity || a.document.id.localeCompare(b.document.id));
    diagnostics.semanticUsed = semantic.length > 0;
    const fused = new Map<string, RetrievalHit>();
    for (const [index, hit] of lexical.entries()) fused.set(hit.document.id, { ...hit, score: 1 / (60 + index + 1) });
    for (const [index, hit] of semantic.entries()) {
      const prior = fused.get(hit.document.id);
      fused.set(hit.document.id, { document: hit.document, matchedTerms: prior?.matchedTerms ?? [], score: (prior?.score ?? 0) + 1 / (60 + index + 1) });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id)).slice(0, limit);
  } catch {
    if (options.signal?.aborted) throw new DOMException('Context request cancelled', 'AbortError');
    diagnostics.fallback = controller.signal.aborted ? 'deadline' : 'unavailable';
    return lexical.slice(0, limit);
  } finally {
    diagnostics.indexedCandidates = candidates.filter(document => cache.documents.get(document.id)?.text === passage(document)).length;
    options.onDiagnostics?.(diagnostics);
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
  }
}
