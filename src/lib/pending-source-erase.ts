// Source removals wait out an undo window before their stored original is erased. This small
// ledger survives a reload or a closed tab so that removed course data never stays on disk.
export const PENDING_SOURCE_ERASE_STORAGE_KEY = 'studentllm.pending-source-erase.v1';

import { SOURCE_REMOVAL_MAX_MS } from './source-removal';

/** `at` is the time the removal started; entries written before it existed have none and count as old. */
export type PendingSourceErase = { id: string; kind: string; at?: number };

// Another tab may still be inside its undo window, so the startup sweep leaves recent entries alone.
// The margin keeps this above the longest a removal can stay pending.
export const PENDING_SOURCE_ERASE_MIN_AGE_MS = SOURCE_REMOVAL_MAX_MS + 15_000;

export function isStalePendingSourceErase(entry: PendingSourceErase, now = Date.now()): boolean {
  return typeof entry.at !== 'number' || now - entry.at >= PENDING_SOURCE_ERASE_MIN_AGE_MS;
}

export function listPendingSourceErases(): PendingSourceErase[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PENDING_SOURCE_ERASE_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingSourceErase => (
      Boolean(entry) && typeof entry === 'object' && typeof (entry as PendingSourceErase).id === 'string' && typeof (entry as PendingSourceErase).kind === 'string'
    )).map((entry) => (typeof entry.at === 'number' ? entry : { id: entry.id, kind: entry.kind }));
  } catch {
    return [];
  }
}

function write(entries: PendingSourceErase[]) {
  try {
    if (entries.length) localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify(entries));
    else localStorage.removeItem(PENDING_SOURCE_ERASE_STORAGE_KEY);
  } catch {
    // Best effort: without storage the erase simply cannot be resumed after a reload.
  }
}

export function addPendingSourceErase(entry: Pick<PendingSourceErase, 'id' | 'kind'>) {
  write([...listPendingSourceErases().filter((item) => item.id !== entry.id), { ...entry, at: Date.now() }]);
}

export function removePendingSourceErase(id: string) {
  write(listPendingSourceErases().filter((item) => item.id !== id));
}
