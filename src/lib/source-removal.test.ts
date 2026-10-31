import { describe, expect, it } from 'vitest';
import { restoreAtPositions, takeWithPositions } from './source-removal';

const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

describe('source removal helpers', () => {
  it('records the original position of every removed item', () => {
    const { kept, removed } = takeWithPositions(items, (item) => item.id === 'b' || item.id === 'd');
    expect(kept.map((item) => item.id)).toEqual(['a', 'c', 'e']);
    expect(removed.map((entry) => [entry.index, entry.item.id])).toEqual([[1, 'b'], [3, 'd']]);
  });

  it('restores removed items in their original order', () => {
    const { kept, removed } = takeWithPositions(items, (item) => item.id === 'b' || item.id === 'd');
    expect(restoreAtPositions(kept, removed).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps items added after the removal and clamps stale positions', () => {
    const { kept, removed } = takeWithPositions(items, (item) => item.id === 'e');
    const restored = restoreAtPositions(kept.slice(0, 2), removed);
    expect(restored.map((item) => item.id)).toEqual(['a', 'b', 'e']);
  });

  it('does not duplicate an item that is already present', () => {
    const { removed } = takeWithPositions(items, (item) => item.id === 'a');
    expect(restoreAtPositions(items, removed)).toHaveLength(5);
  });
});
