export interface RetrievalDocument {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

export interface RetrievalHit {
  document: RetrievalDocument;
  score: number;
  matchedTerms: string[];
}

export interface RetrievalEmbedder {
  embed: (inputs: string[]) => Promise<number[][]>;
}

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

function tokenize(value: string) {
  return value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1 && !stopWords.has(term));
}

export function searchDocuments(documents: RetrievalDocument[], query: string, limit = 5): RetrievalHit[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !documents.length || limit <= 0) return [];

  const tokenized = documents.map((document) => ({
    document,
    terms: tokenize(`${document.id} ${Object.values(document.metadata).join(' ')} ${document.text}`),
  }));
  const documentFrequency = new Map<string, number>();
  for (const item of tokenized) {
    for (const term of new Set(item.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const averageLength = tokenized.reduce((total, item) => total + item.terms.length, 0) / tokenized.length;
  const k1 = 1.2;
  const b = 0.75;
  const totalDocuments = tokenized.length;

  return tokenized
    .map(({ document, terms }) => {
      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      const matchedTerms = queryTerms.filter((term) => frequencies.has(term));
      const score = matchedTerms.reduce((sum, term) => {
        const termFrequency = frequencies.get(term) ?? 0;
        const frequency = documentFrequency.get(term) ?? 0;
        const inverseDocumentFrequency = Math.log(1 + (totalDocuments - frequency + 0.5) / (frequency + 0.5));
        const lengthNormalization = 1 - b + b * (terms.length / Math.max(averageLength, 1));
        return sum + inverseDocumentFrequency * ((termFrequency * (k1 + 1)) / (termFrequency + k1 * lengthNormalization));
      }, 0);
      return { document, score, matchedTerms };
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
    .slice(0, limit);
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue ** 2;
    rightMagnitude += rightValue ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return null;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

/**
 * Blend lexical BM25-style evidence with optional local embeddings.
 * Embeddings are an accelerator for semantic matches, never a replacement for
 * the deterministic lexical fallback used when a local server has no endpoint.
 */
export async function searchDocumentsHybrid(
  documents: RetrievalDocument[],
  query: string,
  embedder: RetrievalEmbedder | null | undefined,
  limit = 5,
): Promise<RetrievalHit[]> {
  const lexicalHits = searchDocuments(documents, query, Math.max(limit * 4, 12));
  if (!embedder || !documents.length || limit <= 0) return lexicalHits.slice(0, limit);
  try {
    const vectors = await embedder.embed([query, ...documents.map((document) => `${document.id}\n${document.text}`)]);
    if (vectors.length !== documents.length + 1 || !vectors[0]?.length) return lexicalHits.slice(0, limit);
    const lexicalById = new Map(lexicalHits.map((hit) => [hit.document.id, hit]));
    const lexicalScores = lexicalHits.map((hit) => hit.score);
    const maximumLexicalScore = Math.max(...lexicalScores, 0);
    const semanticHits = documents.map((document, index) => {
      const similarity = cosineSimilarity(vectors[0], vectors[index + 1]);
      return similarity === null ? null : { document, similarity };
    });
    if (semanticHits.some((hit) => hit === null)) return lexicalHits.slice(0, limit);
    const ranked = semanticHits
      .filter((hit) => hit !== null && (hit.similarity >= 0.25 || lexicalById.has(hit.document.id)))
      .map((hit) => {
        const lexical = lexicalById.get(hit!.document.id);
        const lexicalScore = maximumLexicalScore > 0 ? (lexical?.score ?? 0) / maximumLexicalScore : 0;
        const semanticScore = (hit!.similarity + 1) / 2;
        return {
          document: hit!.document,
          score: semanticScore * 0.58 + lexicalScore * 0.42,
          matchedTerms: lexical?.matchedTerms ?? [],
        };
      })
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
      .slice(0, limit);
    return ranked.length ? ranked : lexicalHits.slice(0, limit);
  } catch {
    return lexicalHits.slice(0, limit);
  }
}
