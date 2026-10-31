export const SOURCE_REMOVAL_UNDO_MS = 8000;

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
