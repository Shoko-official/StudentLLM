import { describe, expect, it } from 'vitest';
import { searchDocuments } from './local-retrieval';

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
});
