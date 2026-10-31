// How much of the browser's storage for this site is used, and whether the browser promised to keep it.
// The estimate covers everything the site stores (the workspace, the original files and the recordings), not only the workspace.

export const STORAGE_WARNING_RATIO = 0.8;
export const STORAGE_PERSIST_ASKED_KEY = 'studentllm.storage.persist-asked';

export interface StorageEstimateInfo {
  usage: number;
  quota: number;
  /** `usage / quota`, between 0 and 1. */
  ratio: number;
  /** At or above the warning ratio. */
  nearLimit: boolean;
}

type StorageManagerLike = Pick<StorageManager, 'estimate'> & Partial<Pick<StorageManager, 'persist' | 'persisted'>>;
type NavigatorLike = { storage?: StorageManagerLike };

function getNavigator(): NavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator;
}

/** Null when the browser cannot say. */
export async function readStorageEstimate(nav: NavigatorLike | undefined = getNavigator()): Promise<StorageEstimateInfo | null> {
  try {
    if (!nav?.storage?.estimate) return null;
    const { usage, quota } = await nav.storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number' || !Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0 || usage < 0) return null;
    const ratio = Math.min(1, usage / quota);
    return { usage, quota, ratio, nearLimit: ratio >= STORAGE_WARNING_RATIO };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function describeStorageUsage(info: StorageEstimateInfo): string {
  const percent = info.ratio > 0 && info.ratio < 0.01 ? '<1' : String(Math.round(info.ratio * 100));
  return `${formatBytes(info.usage)} used of about ${formatBytes(info.quota)} available to this browser (${percent}%).`;
}

export type PersistentStorageState = 'granted' | 'not-granted' | 'unsupported';

export async function readPersistentStorage(nav: NavigatorLike | undefined = getNavigator()): Promise<PersistentStorageState> {
  try {
    if (!nav?.storage?.persisted || !nav.storage.persist) return 'unsupported';
    return await nav.storage.persisted() ? 'granted' : 'not-granted';
  } catch {
    return 'unsupported';
  }
}

/**
 * Asks the browser not to clear this site's data when it runs short of space. Some browsers answer on their own, others
 * show a prompt, so the app asks once per browser profile (and again only when the student presses the button in Settings).
 */
export async function requestPersistentStorage(
  nav: NavigatorLike | undefined = getNavigator(),
  options: { force?: boolean; storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined } = {},
): Promise<PersistentStorageState> {
  try {
    if (!nav?.storage?.persist || !nav.storage.persisted) return 'unsupported';
    if (await nav.storage.persisted()) return 'granted';
    const storage = options.storage;
    if (!options.force && storage?.getItem(STORAGE_PERSIST_ASKED_KEY) === '1') return 'not-granted';
    try {
      storage?.setItem(STORAGE_PERSIST_ASKED_KEY, '1');
    } catch {
      // Asked again next time; the browser keeps its own answer.
    }
    return await nav.storage.persist() ? 'granted' : 'not-granted';
  } catch {
    return 'unsupported';
  }
}
