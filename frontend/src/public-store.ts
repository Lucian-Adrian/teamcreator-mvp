export interface PublicBrowserState {
  schema: 1;
  browserId: string;
  workspaces: import('../../shared/types').ProjectWorkspace[];
  sourceTexts: Record<string, string>;
  requestReceipts: Record<string, { fingerprint: string; state: 'processing' | 'complete'; response?: unknown }>;
}

const DATABASE_NAME = 'teamcreator-public-v1';
const OBJECT_STORE = 'browser-stores';
const BROWSER_ID_KEY = 'teamcreator:public:browser-id:v1';

function createBrowserId(): string {
  const storages: Storage[] = [];
  try { storages.push(window.localStorage); } catch { /* Browser storage may be disabled. */ }
  try { storages.push(window.sessionStorage); } catch { /* Browser storage may be disabled. */ }
  for (const storage of storages) {
    try {
      const existing = storage.getItem(BROWSER_ID_KEY);
      if (existing && /^[a-z0-9-]{20,80}$/i.test(existing)) return existing;
    } catch { /* Continue with the next browser store. */ }
  }
  const next = crypto.randomUUID();
  for (const storage of storages) {
    try { storage.setItem(BROWSER_ID_KEY, next); break; } catch { /* IndexedDB may still be available. */ }
  }
  return next;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable.'));
    const opening = indexedDB.open(DATABASE_NAME, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(OBJECT_STORE)) {
        opening.result.createObjectStore(OBJECT_STORE, { keyPath: 'browserId' });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error('Could not open browser storage.'));
    opening.onblocked = () => reject(new Error('Browser storage is blocked by another tab.'));
  });
}

function fallbackKey(browserId: string): string {
  return `teamcreator:public:${browserId}:v1`;
}

function cloneState(value: PublicBrowserState): PublicBrowserState {
  return structuredClone(value);
}

export class PublicBrowserStore {
  readonly browserId = createBrowserId();
  private readonly prefix = `public-${this.browserId.slice(0, 8)}`;
  private readonly tabId = crypto.randomUUID();
  private database: Promise<IDBDatabase> | null = null;
  private state: PublicBrowserState | null = null;
  private tail: Promise<void> = Promise.resolve();
  private localStorageOnly = false;
  private readOnlyReason = '';
  private writerKey = '';

  get idPrefix(): string { return this.prefix; }

  async initialize(): Promise<void> {
    if (this.state) return;
    try {
      this.database = openDatabase();
      const db = await this.database;
      const stored = await new Promise<PublicBrowserState | undefined>((resolve, reject) => {
        const request = db.transaction(OBJECT_STORE, 'readonly').objectStore(OBJECT_STORE).get(this.browserId);
        request.onsuccess = () => resolve(request.result as PublicBrowserState | undefined);
        request.onerror = () => reject(request.error || new Error('Could not read browser storage.'));
      });
      this.state = stored?.schema === 1 ? { ...stored, requestReceipts: stored.requestReceipts || {} } : this.emptyState();
    } catch {
      this.localStorageOnly = true;
      this.database = null;
      try {
        const raw = window.localStorage.getItem(fallbackKey(this.browserId));
        const stored = raw ? JSON.parse(raw) as PublicBrowserState : null;
        this.state = stored?.schema === 1 ? { ...stored, requestReceipts: stored.requestReceipts || {} } : this.emptyState();
      } catch (error) {
        throw new Error(`Browser-local storage could not be opened: ${messageOf(error)}`);
      }
    }
    if (!this.hasWebLocks()) this.claimSingleWriterTab();
  }

  async read<T>(read: (state: PublicBrowserState) => T): Promise<T> {
    await this.initialize();
    await this.tail;
    return this.withLock('shared', async () => {
      this.state = await this.loadPersisted();
      return read(cloneState(this.state));
    });
  }

  async transact<T>(change: (state: PublicBrowserState) => T): Promise<T> {
    await this.initialize();
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.readOnlyReason) throw new Error(this.readOnlyReason);
      return await this.withLock('exclusive', async () => {
        this.state = await this.loadPersisted();
        const draft = cloneState(this.state);
        const result = change(draft);
        await this.persist(draft);
        this.state = draft;
        return result;
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'PublicApiError' && typeof (error as Error & { status?: unknown }).status === 'number') throw error;
      if (isQuotaError(error)) {
        throw new Error('Browser storage is full. The import was not saved; export a backup or remove browser data before trying a smaller import.');
      }
      throw new Error(`Browser-local changes could not be saved: ${messageOf(error)}`);
    } finally {
      release();
    }
  }

  private emptyState(): PublicBrowserState {
    return { schema: 1, browserId: this.browserId, workspaces: [], sourceTexts: {}, requestReceipts: {} };
  }

  private hasWebLocks(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as Navigator & { locks?: LockManager }).locks;
  }

  private async withLock<T>(mode: 'shared' | 'exclusive', work: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return work();
    return locks.request(`teamcreator-public:${this.browserId}`, { mode }, work);
  }

  private async loadPersisted(): Promise<PublicBrowserState> {
    if (this.localStorageOnly || !this.database) {
      const raw = window.localStorage.getItem(fallbackKey(this.browserId));
      if (!raw) return this.emptyState();
      const stored = JSON.parse(raw) as PublicBrowserState;
      return stored.schema === 1 ? { ...stored, requestReceipts: stored.requestReceipts || {} } : this.emptyState();
    }
    const db = await this.database;
    const stored = await new Promise<PublicBrowserState | undefined>((resolve, reject) => {
      const request = db.transaction(OBJECT_STORE, 'readonly').objectStore(OBJECT_STORE).get(this.browserId);
      request.onsuccess = () => resolve(request.result as PublicBrowserState | undefined);
      request.onerror = () => reject(request.error || new Error('Could not refresh browser storage.'));
    });
    return stored?.schema === 1 ? { ...stored, requestReceipts: stored.requestReceipts || {} } : this.emptyState();
  }

  private claimSingleWriterTab(): void {
    try {
      this.writerKey = `teamcreator:public:${this.browserId}:writer`;
      const current = window.localStorage.getItem(this.writerKey);
      if (current && current !== this.tabId) {
        this.readOnlyReason = 'This browser does not support coordinated multi-tab writes. Another public app tab owns this store; close it before making changes here.';
        return;
      }
      window.localStorage.setItem(this.writerKey, this.tabId);
      if (window.localStorage.getItem(this.writerKey) !== this.tabId) {
        this.readOnlyReason = 'This browser could not claim the single-writer store guard. Reload in one public app tab to continue.';
        return;
      }
      window.addEventListener('pagehide', this.releaseWriterTab, { once: true });
    } catch {
      this.readOnlyReason = 'This browser cannot coordinate public store writes safely. Enable browser storage and use a browser with Web Locks support.';
    }
  }

  private releaseWriterTab = (): void => {
    if (!this.writerKey) return;
    try { if (window.localStorage.getItem(this.writerKey) === this.tabId) window.localStorage.removeItem(this.writerKey); } catch { /* The store may be unavailable during tab close. */ }
  };

  private async persist(state: PublicBrowserState): Promise<void> {
    if (this.localStorageOnly || !this.database) {
      const serialized = JSON.stringify(state);
      if (serialized.length > 2_000_000) {
        throw new DOMException('Fallback storage limit exceeded.', 'QuotaExceededError');
      }
      window.localStorage.setItem(fallbackKey(this.browserId), serialized);
      return;
    }
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(OBJECT_STORE, 'readwrite');
      transaction.objectStore(OBJECT_STORE).put(state);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Browser storage write failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Browser storage write was cancelled.'));
    });
  }
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown storage error.';
}
