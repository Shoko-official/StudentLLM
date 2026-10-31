import { beforeEach, describe, expect, it } from 'vitest';
import { addPendingSourceErase, listPendingSourceErases, PENDING_SOURCE_ERASE_STORAGE_KEY, removePendingSourceErase } from './pending-source-erase';

describe('pending source erase ledger', () => {
  beforeEach(() => localStorage.clear());

  it('adds, lists and removes entries', () => {
    addPendingSourceErase({ id: 'a', kind: 'audio' });
    addPendingSourceErase({ id: 'b', kind: 'text' });
    addPendingSourceErase({ id: 'a', kind: 'audio' });
    expect(listPendingSourceErases()).toEqual([{ id: 'b', kind: 'text' }, { id: 'a', kind: 'audio' }]);

    removePendingSourceErase('a');
    expect(listPendingSourceErases()).toEqual([{ id: 'b', kind: 'text' }]);
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
