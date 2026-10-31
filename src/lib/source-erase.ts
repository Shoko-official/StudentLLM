// Erasing a stored original (a file or a recording) cannot be undone, so it is only done when the workspace that stopped
// listing it is itself safely stored. While saving is paused (another tab, a protected original) or failing (a full
// store), the saved workspace may still list the source: erasing now would leave a source with no file after a reload.
// In those cases the erase is deferred through the pending-erase ledger, whose startup sweep checks references first.

export interface SaveSafety {
  /** Saving is paused in this window: a stale tab, or an unreadable original that must stay as it is. */
  savingPaused: boolean;
  /** The last save did not reach storage. */
  saveFailed: boolean;
}

export interface ErasableSource {
  id: string;
  kind: string;
}

export interface EraseOperations {
  removeBlob: (sourceId: string) => Promise<void>;
  clearChunks: (recordingId: string) => Promise<void>;
  /** Forgets a pending erase once the original is gone (or still needed). */
  forget: (sourceId: string) => void;
  /** Remembers that an original still has to be erased later. */
  remember: (entry: ErasableSource) => void;
}

export function isSafeToErase(safety: SaveSafety): boolean {
  return !safety.savingPaused && !safety.saveFailed;
}

/**
 * Finishes the removal of one source after its undo window. Returns `deferred` when nothing was touched because the
 * workspace is not safely saved; the ledger entry stays so a later start can retry. Throws if the stores fail, again
 * with the ledger entry in place.
 */
export async function eraseRemovedSource(source: ErasableSource, input: { safety: SaveSafety; usedElsewhere: boolean }, operations: EraseOperations): Promise<'erased' | 'kept' | 'deferred'> {
  if (!isSafeToErase(input.safety)) return 'deferred';
  if (input.usedElsewhere) {
    operations.forget(source.id);
    return 'kept';
  }
  await operations.removeBlob(source.id);
  if (source.kind === 'audio') await operations.clearChunks(source.id);
  operations.forget(source.id);
  return 'erased';
}

/**
 * Erases the originals of a deleted course. Each one is written to the ledger first, so an interruption (a crash, a
 * failing store) leaves it to the startup sweep instead of orphaning it. When saving is unsafe, nothing is erased: the
 * course is gone from the screen but the saved workspace may still list it.
 */
export async function eraseCourseSources(
  sources: readonly ErasableSource[],
  input: { safety: SaveSafety; usedElsewhere: (sourceId: string) => boolean },
  operations: EraseOperations,
): Promise<'erased' | 'deferred'> {
  const mine = sources.filter((source) => !input.usedElsewhere(source.id));
  for (const source of mine) operations.remember(source);
  if (!isSafeToErase(input.safety)) return 'deferred';
  for (const source of mine) {
    await operations.removeBlob(source.id);
    await operations.clearChunks(source.id);
    operations.forget(source.id);
  }
  return 'erased';
}

/**
 * The startup sweep: erases the originals of removals that never finished. A source that the loaded workspace still
 * lists is kept. Nothing is erased when the workspace did not load cleanly, because "not listed" then means "not read".
 */
export async function sweepPendingErases(
  entries: readonly ErasableSource[],
  input: { referencedIds: ReadonlySet<string>; workspaceTrusted: boolean },
  operations: EraseOperations,
): Promise<void> {
  if (!input.workspaceTrusted) return;
  for (const entry of entries) {
    if (input.referencedIds.has(entry.id)) {
      operations.forget(entry.id);
      continue;
    }
    try {
      await operations.removeBlob(entry.id);
      if (entry.kind === 'audio') await operations.clearChunks(entry.id);
      operations.forget(entry.id);
    } catch {
      // Keep the entry; the next start retries.
    }
  }
}
