export interface AudioChunkRecord {
  recordingId: string;
  sequence: number;
  blob: Blob;
  recordedAt: number;
}

export type RecordingDurability = 'durable' | 'memory-only';

export interface AudioChunkStore {
  readonly durability: RecordingDurability;
  append: (chunk: AudioChunkRecord) => Promise<void>;
  list: (recordingId: string) => Promise<AudioChunkRecord[]>;
  count: (recordingId: string) => Promise<number>;
  clear: (recordingId: string) => Promise<void>;
}

const DATABASE_NAME = 'studentllm-recordings';
const DATABASE_VERSION = 1;
const STORE_NAME = 'audio-chunks';

function getIndexedDb(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

class MemoryAudioChunkStore implements AudioChunkStore {
  readonly durability = 'memory-only' as const;
  private readonly chunks = new Map<string, AudioChunkRecord[]>();

  async append(chunk: AudioChunkRecord) {
    const current = this.chunks.get(chunk.recordingId) ?? [];
    current.push(chunk);
    this.chunks.set(chunk.recordingId, current);
  }

  async list(recordingId: string) {
    return [...(this.chunks.get(recordingId) ?? [])].sort((left, right) => left.sequence - right.sequence);
  }

  async count(recordingId: string) {
    return this.chunks.get(recordingId)?.length ?? 0;
  }

  async clear(recordingId: string) {
    this.chunks.delete(recordingId);
  }
}

class IndexedDbAudioChunkStore implements AudioChunkStore {
  readonly durability = 'durable' as const;
  private readonly database: Promise<IDBDatabase>;

  constructor(indexedDb: IDBFactory) {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (database.objectStoreNames.contains(STORE_NAME)) return;
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('recordingId', 'recordingId', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked.'));
    });
  }

  async append(chunk: AudioChunkRecord) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      key: `${chunk.recordingId}:${chunk.sequence}`,
      ...chunk,
    });
    await transactionResult(transaction);
  }

  async list(recordingId: string) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).index('recordingId').getAll(IDBKeyRange.only(recordingId));
    const records = await requestResult(request) as Array<AudioChunkRecord & { key: string }>;
    return records.sort((left, right) => left.sequence - right.sequence).map(({ key: _key, ...chunk }) => chunk);
  }

  async count(recordingId: string) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).index('recordingId').count(IDBKeyRange.only(recordingId));
    return requestResult(request);
  }

  async clear(recordingId: string) {
    const database = await this.database;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.index('recordingId').openCursor(IDBKeyRange.only(recordingId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await transactionResult(transaction);
  }
}

export function createRecordingChunkStore(indexedDb: IDBFactory | undefined = getIndexedDb()): AudioChunkStore {
  return indexedDb ? new IndexedDbAudioChunkStore(indexedDb) : new MemoryAudioChunkStore();
}
