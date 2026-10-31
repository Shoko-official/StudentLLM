import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPendingSourceErase, isStalePendingSourceErase, listPendingSourceErases, PENDING_SOURCE_ERASE_MIN_AGE_MS, PENDING_SOURCE_ERASE_STORAGE_KEY, removePendingSourceErase } from './pending-source-erase';

describe('pending source erase ledger', () => {
  beforeEach(() => localStorage.clear());

  it('adds, lists and removes entries', () => {
    addPendingSourceErase({ id: 'a', kind: 'audio' });
    addPendingSourceErase({ id: 'b', kind: 'text' });
    addPendingSourceErase({ id: 'a', kind: 'audio' });
    expect(listPendingSourceErases().map((entry) => [entry.id, entry.kind])).toEqual([['b', 'text'], ['a', 'audio']]);

    removePendingSourceErase('a');
    expect(listPendingSourceErases().map((entry) => entry.id)).toEqual(['b']);
    removePendingSourceErase('b');
    expect(localStorage.getItem(PENDING_SOURCE_ERASE_STORAGE_KEY)).toBeNull();
  });

  it('ignores corrupt storage content', () => {
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, '{not json');
    expect(listPendingSourceErases()).toEqual([]);
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify([{ id: 1 }, null, { id: 'ok', kind: 'pdf' }]));
    expect(listPendingSourceErases()).toEqual([{ id: 'ok', kind: 'pdf' }]);
  });
});

describe('pending source erase across tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stamps each entry with the time of the removal', () => {
    addPendingSourceErase({ id: 'a', kind: 'text' });
    expect(listPendingSourceErases()[0].at).toBe(Date.now());
  });

  it('lets a second tab sweep only entries older than the undo window plus margin', () => {
    // Tab A removes a source and can still undo it. Tab B starts a few seconds later and sweeps.
    addPendingSourceErase({ id: 'fresh', kind: 'text' });
    vi.advanceTimersByTime(10_000);
    // An entry left behind by a session that closed long ago.
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify([
      ...listPendingSourceErases(),
      { id: 'old', kind: 'text', at: Date.now() - PENDING_SOURCE_ERASE_MIN_AGE_MS - 1 },
    ]));

    const swept = listPendingSourceErases().filter((entry) => isStalePendingSourceErase(entry)).map((entry) => entry.id);
    expect(swept).toEqual(['old']);

    // The fresh entry is swept on a later start, once it has aged out.
    vi.advanceTimersByTime(PENDING_SOURCE_ERASE_MIN_AGE_MS);
    expect(listPendingSourceErases().filter((entry) => isStalePendingSourceErase(entry)).map((entry) => entry.id)).toEqual(['fresh', 'old']);
  });

  it('treats legacy entries without a timestamp as old', () => {
    localStorage.setItem(PENDING_SOURCE_ERASE_STORAGE_KEY, JSON.stringify([{ id: 'legacy', kind: 'text' }]));
    expect(isStalePendingSourceErase(listPendingSourceErases()[0])).toBe(true);
  });

  it('keeps the sweep margin above the longest a removal can stay pending', async () => {
    const { SOURCE_REMOVAL_MAX_MS } = await import('./source-removal');
    expect(PENDING_SOURCE_ERASE_MIN_AGE_MS).toBeGreaterThan(SOURCE_REMOVAL_MAX_MS);
  });
});

describe('a full localStorage', () => {
  it('keeps the erase ledger for the browsing session instead of dropping it', () => {
    localStorage.clear();
    sessionStorage.clear();
    const realSet = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    });
    addPendingSourceErase({ id: 'source-a', kind: 'document' });
    expect(listPendingSourceErases().map((entry) => entry.id)).toEqual(['source-a']);
    expect(localStorage.getItem(PENDING_SOURCE_ERASE_STORAGE_KEY)).toBeNull();

    spy.mockRestore();
    // With room again, the next write moves everything back to localStorage.
    addPendingSourceErase({ id: 'source-b', kind: 'audio' });
    expect(JSON.parse(localStorage.getItem(PENDING_SOURCE_ERASE_STORAGE_KEY)!).map((entry: { id: string }) => entry.id).sort()).toEqual(['source-a', 'source-b']);
    expect(sessionStorage.getItem(PENDING_SOURCE_ERASE_STORAGE_KEY)).toBeNull();
    removePendingSourceErase('source-a');
    removePendingSourceErase('source-b');
    expect(listPendingSourceErases()).toEqual([]);
  });
});
