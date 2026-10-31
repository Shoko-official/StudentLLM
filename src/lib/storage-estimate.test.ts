import { describe, expect, it, vi } from 'vitest';
import {
  describeStorageUsage,
  formatBytes,
  readPersistentStorage,
  readStorageEstimate,
  requestPersistentStorage,
  STORAGE_PERSIST_ASKED_KEY,
  STORAGE_WARNING_RATIO,
} from './storage-estimate';

const nav = (storage: Record<string, unknown> | undefined) => ({ storage }) as unknown as Parameters<typeof readStorageEstimate>[0];
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

describe('storage estimate', () => {
  it('reports usage and quota', async () => {
    const info = await readStorageEstimate(nav({ estimate: async () => ({ usage: 50 * 1024 * 1024, quota: 1024 * 1024 * 1024 }) }));
    expect(info).toMatchObject({ usage: 50 * 1024 * 1024, quota: 1024 * 1024 * 1024, nearLimit: false });
    expect(info!.ratio).toBeCloseTo(0.049, 3);
    expect(describeStorageUsage(info!)).toBe('50.0 MB used of about 1.0 GB available to this browser (5%).');
  });

  it('warns at 80% and not below', async () => {
    const at = (ratio: number) => readStorageEstimate(nav({ estimate: async () => ({ usage: ratio * 1000, quota: 1000 }) }));
    expect((await at(0.79))!.nearLimit).toBe(false);
    expect((await at(STORAGE_WARNING_RATIO))!.nearLimit).toBe(true);
    expect((await at(0.97))!.nearLimit).toBe(true);
  });

  it('caps the ratio at 100% and shows a tiny share as under 1%', async () => {
    expect((await readStorageEstimate(nav({ estimate: async () => ({ usage: 2000, quota: 1000 }) })))!.ratio).toBe(1);
    expect(describeStorageUsage((await readStorageEstimate(nav({ estimate: async () => ({ usage: 1024, quota: 1024 * 1024 * 1024 }) })))!)).toContain('(<1%)');
  });

  it.each([
    ['no storage manager', undefined],
    ['no estimate method', {}],
    ['an estimate that throws', { estimate: async () => { throw new Error('denied'); } }],
    ['no quota', { estimate: async () => ({ usage: 1, quota: 0 }) }],
    ['missing numbers', { estimate: async () => ({}) }],
    ['negative usage', { estimate: async () => ({ usage: -1, quota: 10 }) }],
  ])('returns null for %s', async (_name, storage) => {
    expect(await readStorageEstimate(nav(storage))).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
  });
});

describe('persistent storage', () => {
  it('asks once, remembers that it asked, and reports the answer', async () => {
    const persist = vi.fn(async () => true);
    const storage = memory();
    const manager = { estimate: async () => ({}), persisted: async () => false, persist };

    expect(await requestPersistentStorage(nav(manager), { storage })).toBe('granted');
    expect(storage.getItem(STORAGE_PERSIST_ASKED_KEY)).toBe('1');
    expect(await requestPersistentStorage(nav(manager), { storage })).toBe('not-granted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('asks again when the student presses the button', async () => {
    const persist = vi.fn(async () => false);
    const storage = memory();
    storage.setItem(STORAGE_PERSIST_ASKED_KEY, '1');
    expect(await requestPersistentStorage(nav({ persisted: async () => false, persist }), { storage, force: true })).toBe('not-granted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the browser already promised', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage(nav({ persisted: async () => true, persist }), { storage: memory() })).toBe('granted');
    expect(persist).not.toHaveBeenCalled();
  });

  const throwing = async (): Promise<boolean> => { throw new Error('nope'); };
  it.each<[string, Record<string, unknown> | undefined]>([
    ['unsupported', undefined],
    ['partial support', { persisted: async () => false }],
    ['a browser that throws', { persisted: throwing, persist: throwing }],
  ])('treats %s as unsupported', async (_name, manager) => {
    expect(await requestPersistentStorage(nav(manager), { storage: memory() })).toBe('unsupported');
  });

  it('reads the current state without asking', async () => {
    expect(await readPersistentStorage(nav({ persisted: async () => true, persist: async () => true }))).toBe('granted');
    expect(await readPersistentStorage(nav({ persisted: async () => false, persist: async () => true }))).toBe('not-granted');
    expect(await readPersistentStorage(nav(undefined))).toBe('unsupported');
  });
});
