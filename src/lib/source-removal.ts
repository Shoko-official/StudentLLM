export const SOURCE_REMOVAL_UNDO_MS = 8000;
/** A removal is finalized at most this long after it was created, however long the toast is hovered or focused. */
export const SOURCE_REMOVAL_MAX_MS = 30_000;

export type RemovedEntry<T> = { index: number; item: T };

/** Splits `list` into the kept items and the removed ones, remembering where each removed item sat. */
export function takeWithPositions<T>(list: readonly T[], shouldRemove: (item: T) => boolean): { kept: T[]; removed: RemovedEntry<T>[] } {
  const kept: T[] = [];
  const removed: RemovedEntry<T>[] = [];
  list.forEach((item, index) => {
    if (shouldRemove(item)) removed.push({ index, item });
    else kept.push(item);
  });
  return { kept, removed };
}

/** Puts previously removed items back at their original positions, skipping any whose id is already present. */
export function restoreAtPositions<T extends { id: string }>(list: readonly T[], removed: readonly RemovedEntry<T>[]): T[] {
  const present = new Set(list.map((item) => item.id));
  const next = [...list];
  for (const entry of [...removed].sort((a, b) => a.index - b.index)) {
    if (present.has(entry.item.id)) continue;
    next.splice(Math.min(entry.index, next.length), 0, entry.item);
    present.add(entry.item.id);
  }
  return next;
}

/** True when both lists hold exactly the same ids, whatever their order. */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((id) => left.has(id));
}

/**
 * Decides how Undo treats the course note:
 * - `snapshot`: the same segments are back and nobody touched the note, so restore the pre-removal note verbatim;
 * - `keep`: the note changed during the undo window, so keep the current one rather than overwrite it;
 * - `rebuild`: the segments differ, so rebuild the note from the restored transcript.
 */
export function chooseNoteOnUndo(input: { hasSnapshot: boolean; sameSegments: boolean; currentNote: unknown; noteAfterRemoval: unknown }): 'snapshot' | 'keep' | 'rebuild' {
  const edited = input.noteAfterRemoval !== undefined && input.currentNote !== input.noteAfterRemoval;
  if (edited) return 'keep';
  return input.hasSnapshot && input.sameSegments ? 'snapshot' : 'rebuild';
}
