import { describe, expect, it, vi } from 'vitest';
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
    expect(searchDocuments(documents, '14:18', 1)[0].document.id).toBe('attention');
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

  it('normalizes French stopwords, plural terms and mathematical symbol names', () => {
    const docs = [{ id: 'fluid', text: 'La masse volumique ρ intervient dans les pressions hydrostatiques.', metadata: {} }, { id: 'poem', text: 'Une histoire raconte une promenade et une aventure.', metadata: {} }];
    expect(searchDocuments(docs, 'une pression hydrostatique rho', 1)[0].document.id).toBe('fluid');
    expect(searchDocuments(docs, 'une une une', 2)).toEqual([]);
  });

  it('keeps query and passage modes separate, caches documents, and invalidates changed content', async () => {
    const corpus = [{ id: 'a', text: 'Buoyancy equals displaced fluid weight.', metadata: {} }, { id: 'b', text: 'A historical sailing voyage.', metadata: {} }];
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    const embedQuery = vi.fn(async () => [1, 0]);
    const embedDocuments = vi.fn(async (inputs: string[]) => inputs.map(text => text.includes('Buoyancy') ? [1, 0] : [0, 1]));
    const embedder = { embed, embedQuery, embedDocuments };
    expect((await searchDocumentsHybrid(corpus, 'floating vessel', embedder, 1))[0].document.id).toBe('a');
    await searchDocumentsHybrid(corpus, 'vessel floats', embedder, 1);
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledTimes(2);
    expect(embed).not.toHaveBeenCalled();
    corpus[0] = { ...corpus[0], text: 'Buoyancy has a revised explanation.' };
    await searchDocumentsHybrid(corpus, 'vessel floats', embedder, 1);
    expect(embedDocuments).toHaveBeenCalledTimes(2);
    expect(embedDocuments.mock.calls[1][0]).toHaveLength(1);
    expect(embedQuery).toHaveBeenCalledTimes(2);
    expect(await searchDocumentsHybrid([], 'vessel floats', embedder, 1)).toEqual([]);
  });

  it('aborts the semantic deadline and does not begin later batches after falling back', async () => {
    vi.useFakeTimers();
    try {
      const corpus = Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: `Buoyancy passage ${i}`, metadata: {} }));
      let signal: AbortSignal | undefined;
      const embedDocuments = vi.fn((_inputs: string[], options?: { signal?: AbortSignal }) => { signal = options?.signal; return new Promise<number[][]>(() => {}); });
      const pending = searchDocumentsHybrid(corpus, 'Buoyancy', { embed: async () => [[1]], embedQuery: async () => [1], embedDocuments }, 2);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await pending).toHaveLength(2);
      expect(signal?.aborted).toBe(true);
      expect(embedDocuments).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('propagates caller cancellation without treating it as a retrieval answer', async () => {
    const controller = new AbortController();
    const embedQuery = vi.fn((_input: string, options?: { signal?: AbortSignal }) => new Promise<number[]>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))));
    const pending = searchDocumentsHybrid(documents, 'attention', { embed: async () => [], embedQuery }, 2, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('combines French paraphrase vectors with lexical evidence rather than requiring shared words', async () => {
    const corpus = [
      { id: 'buoyancy', text: 'La poussée d’Archimède égale le poids du fluide déplacé.', metadata: {} },
      { id: 'history', text: 'Pourquoi les bateaux du dix-huitième siècle transportaient-ils des épices ?', metadata: {} },
    ];
    const query = 'Pourquoi un navire reste-t-il à la surface ?';
    const hits = await searchDocumentsHybrid(corpus, query, {
      embed: async () => [],
      embedQuery: async () => [1, 0],
      embedDocuments: async inputs => inputs.map(text => text.includes('Archimède') ? [1, 0] : [0, 1]),
    }, 2);
    expect(hits.some(hit => hit.document.id === 'buoyancy')).toBe(true);
    expect(hits.find(hit => hit.document.id === 'buoyancy')?.matchedTerms).toEqual([]);
  });

  it('retains the best semantic rank below an uncalibrated cosine threshold', async () => {
    const corpus = [
      { id: 'buoyancy', text: 'Archimedes describes displaced fluid weight.', metadata: {} },
      { id: 'distractor', text: 'Ancient trade routes transported spices.', metadata: {} },
    ];
    const hits = await searchDocumentsHybrid(corpus, 'Pourquoi un navire flotte ?', {
      embed: async () => [], embedQuery: async () => [1, 0],
      embedDocuments: async inputs => inputs.map(text => text.includes('Archimedes') ? [0.138, Math.sqrt(1 - 0.138 ** 2)] : [0.05, Math.sqrt(1 - 0.05 ** 2)]),
    }, 1);
    expect(hits[0].document.id).toBe('buoyancy');
    expect(hits[0].matchedTerms).toEqual([]);
  });
});
