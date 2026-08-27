export type SourceBlobDurability = 'durable' | 'memory-only';

export interface SourceBlobStore {
  readonly durability: SourceBlobDurability;
  save: (sourceId: string, blob: Blob) => Promise<void>;
  load: (sourceId: string) => Promise<Blob | null>;
  remove: (sourceId: string) => Promise<void>;
}

const DATABASE_NAME = 'studentllm-sources';
const DATABASE_VERSION = 1;
const STORE_NAME = 'source-blobs';

function getIndexedDb(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

class MemorySourceBlobStore implements SourceBlobStore {
  readonly durability = 'memory-only' as const;
  private readonly blobs = new Map<string, Blob>();

  async save(sourceId: string, blob: Blob) {
    this.blobs.set(sourceId, blob);
  }

  async load(sourceId: string) {
    return this.blobs.get(sourceId) ?? null;
  }

  async remove(sourceId: string) {
    this.blobs.delete(sourceId);
  }
}

class IndexedDbSourceBlobStore implements SourceBlobStore {
  readonly durability = 'durable' as const;
  private readonly database: Promise<IDBDatabase>;

  constructor(indexedDb: IDBFactory) {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'sourceId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open source storage.'));
      request.onblocked = () => reject(new Error('Source storage upgrade is blocked.'));
    });
  }

  async save(sourceId: string, blob: Blob) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ sourceId, blob });
    await transactionResult(transaction);
  }

  async load(sourceId: string) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(sourceId);
    const record = await new Promise<{ sourceId: string; blob: Blob } | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to read source blob.'));
    });
    return record?.blob ?? null;
  }

  async remove(sourceId: string) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(sourceId);
    await transactionResult(transaction);
  }
}

export function createSourceBlobStore(indexedDb: IDBFactory | undefined = getIndexedDb()): SourceBlobStore {
  return indexedDb ? new IndexedDbSourceBlobStore(indexedDb) : new MemorySourceBlobStore();
}
