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

  const tokenized = documents.map((document) => ({ document, terms: tokenize(`${document.id} ${document.text}`) }));
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
