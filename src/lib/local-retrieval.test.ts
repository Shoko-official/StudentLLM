import { describe, expect, it } from 'vitest';
import { searchDocuments, searchDocumentsHybrid } from './local-retrieval';

const documents = [
  { id: 'attention', text: 'Scaled dot-product attention divides logits by the square root of the key dimension.', metadata: { timestamp: '01:14:18' } },
  { id: 'softmax', text: 'Softmax converts logits into a probability distribution.', metadata: { timestamp: '01:15:02' } },
  { id: 'optimizers', text: 'Adam updates parameters with first and second moment estimates.', metadata: { timestamp: '00:42:11' } },
];

describe('local lexical retrieval', () => {
  it('ranks the most relevant transcript document first', () => {
    const hits = searchDocuments(documents, 'Why divide attention logits by key dimension?', 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ document: documents[0], matchedTerms: expect.arrayContaining(['attention', 'key', 'dimension']) });
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('normalizes accents and ignores queries with no searchable terms', () => {
    expect(searchDocuments([{ ...documents[0], text: 'Regularization stabilizes the model.' }], 'regularization model')).toHaveLength(1);
    expect(searchDocuments(documents, '???')).toEqual([]);
  });

  it('returns no unrelated documents and respects the limit', () => {
    expect(searchDocuments(documents, 'convolution', 5)).toEqual([]);
    expect(searchDocuments(documents, 'logits', 1)).toHaveLength(1);
    expect(searchDocuments(documents, 'What is the boiling point of mercury on Mars?')).toEqual([]);
  });

  it('searches source metadata alongside indexed passage text', () => {
    const importedSource = {
      id: 'resource-42:chunk-3',
      text: 'Gradient descent updates model parameters iteratively.',
      metadata: { resourceName: 'optimization-handout.pdf', part: '4' },
    };

    expect(searchDocuments([importedSource], 'optimization handout pdf')).toMatchObject([
      { document: importedSource, matchedTerms: expect.arrayContaining(['optimization', 'handout', 'pdf']) },
    ]);
  });

  it('uses semantic similarity when an OpenAI-compatible embedding endpoint is available', async () => {
    const candidates = [
      { id: 'semantic-1', text: 'The model normalizes attention scores.', metadata: {} },
      { id: 'semantic-2', text: 'The laboratory stores samples in a freezer.', metadata: {} },
    ];
    const hits = await searchDocumentsHybrid(candidates, 'stabilize transformer weights', {
      embed: async (inputs) => inputs.map((input) => input.includes('stabilize') ? [1, 0] : input.includes('normalizes') ? [0.95, 0.05] : [0.05, 0.95]),
    }, 1);

    expect(hits[0].document).toBe(candidates[0]);
    expect(hits[0].matchedTerms).toEqual([]);
  });

  it('falls back to lexical retrieval when embeddings are unavailable or malformed', async () => {
    const hits = await searchDocumentsHybrid(documents, 'softmax logits', {
      embed: async () => [[1], [1, 2]],
    }, 2);

    expect(hits[0].document).toBe(documents[1]);
  });
});
