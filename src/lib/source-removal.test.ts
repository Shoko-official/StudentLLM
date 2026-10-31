import { describe, expect, it } from 'vitest';
import { chooseNoteOnUndo, restoreAtPositions, sameIdSet, takeWithPositions } from './source-removal';

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

describe('sameIdSet', () => {
  it('compares ids regardless of order', () => {
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIdSet([], [])).toBe(true);
  });

  it('detects missing, extra and duplicated ids', () => {
    expect(sameIdSet(['a', 'b'], ['a'])).toBe(false);
    expect(sameIdSet(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameIdSet(['a', 'a'], ['a', 'b'])).toBe(false);
  });
});

describe('chooseNoteOnUndo', () => {
  const note = { id: 'after-removal' };

  it('restores the snapshot when the same segments are back and the note is untouched', () => {
    expect(chooseNoteOnUndo({ hasSnapshot: true, sameSegments: true, currentNote: note, noteAfterRemoval: note })).toBe('snapshot');
  });

  it('keeps the current note when it changed during the undo window', () => {
    expect(chooseNoteOnUndo({ hasSnapshot: true, sameSegments: true, currentNote: { id: 'edited' }, noteAfterRemoval: note })).toBe('keep');
  });

  it('rebuilds when the segments differ or there is no snapshot', () => {
    expect(chooseNoteOnUndo({ hasSnapshot: true, sameSegments: false, currentNote: note, noteAfterRemoval: note })).toBe('rebuild');
    expect(chooseNoteOnUndo({ hasSnapshot: false, sameSegments: true, currentNote: note, noteAfterRemoval: note })).toBe('rebuild');
  });

  it('treats an unknown post-removal note as untouched', () => {
    expect(chooseNoteOnUndo({ hasSnapshot: true, sameSegments: true, currentNote: note, noteAfterRemoval: undefined })).toBe('snapshot');
  });
});
