import { describe, expect, it, vi } from 'vitest';
import { eraseCourseSources, eraseRemovedSource, isSafeToErase, sweepPendingErases, type EraseOperations, type ErasableSource } from './source-erase';

function operations(overrides: Partial<EraseOperations> = {}): EraseOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    removeBlob: vi.fn(async (id: string) => { calls.push(`blob:${id}`); }),
    clearChunks: vi.fn(async (id: string) => { calls.push(`chunks:${id}`); }),
    forget: vi.fn((id: string) => { calls.push(`forget:${id}`); }),
    remember: vi.fn((entry: ErasableSource) => { calls.push(`remember:${entry.id}`); }),
    ...overrides,
  };
}
const safe = { savingPaused: false, saveFailed: false };

describe('erasing a removed source', () => {
  it('erases the original and forgets the ledger entry when saving is healthy', async () => {
    const ops = operations();
    expect(await eraseRemovedSource({ id: 'a', kind: 'audio' }, { safety: safe, usedElsewhere: false }, ops)).toBe('erased');
    expect(ops.calls).toEqual(['blob:a', 'chunks:a', 'forget:a']);
  });

  it.each([
    ['paused', { savingPaused: true, saveFailed: false }],
    ['failing', { savingPaused: false, saveFailed: true }],
    ['paused and failing', { savingPaused: true, saveFailed: true }],
  ])('keeps the original and the ledger entry while saving is %s', async (_name, safety) => {
    const ops = operations();
    expect(await eraseRemovedSource({ id: 'a', kind: 'audio' }, { safety, usedElsewhere: false }, ops)).toBe('deferred');
    expect(ops.calls).toEqual([]);
  });

  it('keeps a file another course still uses', async () => {
    const ops = operations();
    expect(await eraseRemovedSource({ id: 'a', kind: 'document' }, { safety: safe, usedElsewhere: true }, ops)).toBe('kept');
    expect(ops.calls).toEqual(['forget:a']);
  });

  it('leaves the ledger entry when the store fails, so the next start retries', async () => {
    const ops = operations({ removeBlob: vi.fn(async () => { throw new Error('locked'); }) });
    await expect(eraseRemovedSource({ id: 'a', kind: 'document' }, { safety: safe, usedElsewhere: false }, ops)).rejects.toThrow('locked');
    expect(ops.forget).not.toHaveBeenCalled();
  });

  it('only clears recording chunks for audio', async () => {
    const ops = operations();
    await eraseRemovedSource({ id: 'a', kind: 'image' }, { safety: safe, usedElsewhere: false }, ops);
    expect(ops.clearChunks).not.toHaveBeenCalled();
  });

  it('is safe only when nothing is paused and nothing failed', () => {
    expect(isSafeToErase(safe)).toBe(true);
    expect(isSafeToErase({ savingPaused: true, saveFailed: false })).toBe(false);
    expect(isSafeToErase({ savingPaused: false, saveFailed: true })).toBe(false);
  });
});

describe('erasing the originals of a deleted course', () => {
  const sources = [{ id: 'a', kind: 'audio' }, { id: 'b', kind: 'document' }, { id: 'shared', kind: 'document' }];

  it('erases what no other course uses', async () => {
    const ops = operations();
    expect(await eraseCourseSources(sources, { safety: safe, usedElsewhere: (id) => id === 'shared' }, ops)).toBe('erased');
    // Written to the ledger before anything is erased, and forgotten one by one as each original is gone.
    expect(ops.calls).toEqual(['remember:a', 'remember:b', 'blob:a', 'chunks:a', 'forget:a', 'blob:b', 'chunks:b', 'forget:b']);
  });

  it('stops at the first failure and leaves the rest in the ledger', async () => {
    const ops = operations({ removeBlob: vi.fn(async (id: string) => { if (id === 'a') throw new Error('locked'); }) });
    await expect(eraseCourseSources(sources, { safety: safe, usedElsewhere: (id) => id === 'shared' }, ops)).rejects.toThrow('locked');
    expect(ops.remember).toHaveBeenCalledTimes(2);
    expect(ops.forget).not.toHaveBeenCalled();
  });

  it('remembers them instead of erasing while saving is paused or failing, except those another course uses', async () => {
    for (const safety of [{ savingPaused: true, saveFailed: false }, { savingPaused: false, saveFailed: true }]) {
      const ops = operations();
      expect(await eraseCourseSources(sources, { safety, usedElsewhere: (id) => id === 'shared' }, ops)).toBe('deferred');
      expect(ops.calls).toEqual(['remember:a', 'remember:b']);
    }
  });
});

describe('the startup sweep', () => {
  const entries = [{ id: 'gone', kind: 'audio' }, { id: 'still-listed', kind: 'document' }];

  it('erases unreferenced originals and forgets entries for sources that are still listed', async () => {
    const ops = operations();
    await sweepPendingErases(entries, { referencedIds: new Set(['still-listed']), workspaceTrusted: true }, ops);
    expect(ops.calls).toEqual(['blob:gone', 'chunks:gone', 'forget:gone', 'forget:still-listed']);
  });

  it('erases nothing when the workspace did not load cleanly, because unlisted then means unread', async () => {
    const ops = operations();
    await sweepPendingErases(entries, { referencedIds: new Set(), workspaceTrusted: false }, ops);
    expect(ops.calls).toEqual([]);
  });

  it('keeps the entry of an original that fails to erase and carries on', async () => {
    const ops = operations({ removeBlob: vi.fn(async (id: string) => { if (id === 'gone') throw new Error('busy'); }) });
    await sweepPendingErases(entries, { referencedIds: new Set(['still-listed']), workspaceTrusted: true }, ops);
    expect(ops.forget).not.toHaveBeenCalledWith('gone');
    expect(ops.forget).toHaveBeenCalledWith('still-listed');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property: whatever happens to saving, a source that a saved (or on-screen) course still lists keeps its original.

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

type Courses = Map<string, Set<string>>;
const clone = (courses: Courses): Courses => new Map([...courses].map(([id, sources]) => [id, new Set(sources)]));

class Model {
  memory: Courses = new Map([['c1', new Set<string>()], ['c2', new Set<string>()], ['c3', new Set<string>()]]);
  persisted: Courses = clone(this.memory);
  blobs = new Set<string>();
  ledger = new Map<string, string>();
  pending: Array<{ course: string; id: string }> = [];
  paused = false;
  failed = false;
  full = false;
  trusted = true;

  readonly ops: EraseOperations = {
    removeBlob: async (id) => { this.blobs.delete(id); },
    clearChunks: async () => undefined,
    forget: (id) => { this.ledger.delete(id); },
    remember: (entry) => { this.ledger.set(entry.id, entry.kind); },
  };

  usedElsewhere(id: string, except?: string) {
    return [...this.memory].some(([course, sources]) => course !== except && sources.has(id));
  }

  /** The app saves on every change and waits for the save before it erases anything. */
  save() {
    if (this.paused) return;
    if (this.full) {
      this.failed = true;
      return;
    }
    this.persisted = clone(this.memory);
    this.failed = false;
  }

  get safety() {
    return { savingPaused: this.paused, saveFailed: this.failed };
  }

  invariantViolation(): string | null {
    const listed = new Set([...this.memory.values(), ...this.persisted.values()].flatMap((sources) => [...sources]));
    for (const id of listed) if (!this.blobs.has(id)) return `${id} is listed but its original is gone`;
    return null;
  }
}

/** The app finishes a removal that is still in its undo window before it starts a removal or a course deletion. */
async function flushPending(model: Model, guarded: boolean) {
  while (model.pending.length) {
    const entry = model.pending.shift()!;
    model.save();
    if (guarded) await eraseRemovedSource({ id: entry.id, kind: 'document' }, { safety: model.safety, usedElsewhere: model.usedElsewhere(entry.id) }, model.ops);
    else if (!model.usedElsewhere(entry.id)) { await model.ops.removeBlob(entry.id); model.ledger.delete(entry.id); }
  }
}

async function step(model: Model, next: () => number, guarded: boolean): Promise<string> {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const course = pick(['c1', 'c2', 'c3']);
  const id = pick(['s1', 's2', 's3', 's4']);
  const operation = pick(['add', 'add', 'save', 'fill', 'free', 'pause', 'remove', 'commit', 'undo', 'delete', 'reload', 'reloadUnreadable'] as const);
  const label = `${operation}(${course},${id})`;
  switch (operation) {
    case 'add':
      if (!model.memory.has(course)) break;
      model.blobs.add(id);
      model.memory.get(course)!.add(id);
      model.ledger.delete(id);
      model.save();
      break;
    case 'save': model.save(); break;
    case 'fill': model.full = true; break;
    case 'free': model.full = false; model.save(); break;
    case 'pause': model.paused = true; break;
    case 'remove': {
      if (!model.memory.get(course)?.has(id)) break;
      await flushPending(model, guarded);
      const sources = model.memory.get(course)!;
      sources.delete(id);
      model.ledger.set(id, 'document');
      model.pending.push({ course, id });
      model.save();
      break;
    }
    case 'undo': {
      const index = model.pending.findIndex((entry) => model.memory.has(entry.course));
      if (index < 0) break;
      const [entry] = model.pending.splice(index, 1);
      model.memory.get(entry.course)!.add(entry.id);
      model.ledger.delete(entry.id);
      model.save();
      break;
    }
    case 'commit': await flushPending(model, guarded); break;
    case 'delete': {
      if (!model.memory.has(course)) break;
      await flushPending(model, guarded);
      const sources = model.memory.get(course)!;
      const removed = [...sources].map((sourceId) => ({ id: sourceId, kind: 'document' }));
      model.memory.delete(course);
      model.save();
      if (guarded) await eraseCourseSources(removed, { safety: model.safety, usedElsewhere: (sourceId) => model.usedElsewhere(sourceId) }, model.ops);
      else for (const source of removed) if (!model.usedElsewhere(source.id)) await model.ops.removeBlob(source.id);
      break;
    }
    case 'reload':
    case 'reloadUnreadable': {
      // A fresh tab: it reads the saved workspace (or fails to), then sweeps the ledger.
      const unreadable = operation === 'reloadUnreadable';
      model.pending = [];
      model.paused = unreadable;
      model.failed = false;
      model.trusted = !unreadable;
      model.memory = unreadable ? new Map() : clone(model.persisted);
      const referenced = new Set([...model.memory.values()].flatMap((sources) => [...sources]));
      const entries = [...model.ledger].map(([entryId, kind]) => ({ id: entryId, kind }));
      if (guarded) await sweepPendingErases(entries, { referencedIds: referenced, workspaceTrusted: model.trusted }, model.ops);
      else for (const entry of entries) if (!referenced.has(entry.id)) { await model.ops.removeBlob(entry.id); model.ledger.delete(entry.id); }
      break;
    }
  }
  return label;
}

async function run(seed: number, guarded: boolean): Promise<string | null> {
  const next = random(seed);
  const model = new Model();
  const log: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    log.push(await step(model, next, guarded));
    // While a window is unreadable its (empty) memory is not the saved workspace; only saved or on-screen listings count.
    const violation = model.invariantViolation();
    if (violation) return `seed ${seed}, step ${index}: ${violation} after ${log.slice(-12).join(' ')}`;
  }
  return null;
}

describe('property: random saves, failures, pauses, removals and deletions', () => {
  it('never lose an original that a saved or on-screen course still lists', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const failure = await run(seed, true);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });

  it('the check itself is sharp: without the rules the same sequences do lose originals', async () => {
    let violations = 0;
    for (let seed = 1; seed <= 400; seed += 1) if (await run(seed, false)) violations += 1;
    expect(violations).toBeGreaterThan(20);
  });
});
