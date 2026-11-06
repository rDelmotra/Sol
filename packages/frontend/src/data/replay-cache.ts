import type { HistoryCatalogResponse } from './replay-types';

// ============================================================
// Per-day replay catalog cache (IndexedDB).
//
// Stores each /api/history/catalog?day= response on disk, keyed by UTC day. The
// archive is immutable (a past day never changes), so a day once fetched is served
// from disk on every later visit. Its own database (never collides with the live
// catalog cache or the legacy history cache). Bounded: the oldest-fetched days are
// pruned past MAX_DAYS (a modern day is ~10–20 MB). Every operation degrades to
// null / no-op on private mode, disabled storage, quota errors or node (tests).
// ============================================================

const DB_NAME = 'orbitwatch-replay';
const DB_VERSION = 1;
const STORE = 'catalog-days';
/** Days kept on disk; older-fetched days are evicted on write. */
export const REPLAY_CACHE_MAX_DAYS = 24;

export interface ReplayDayRecord {
  day: string;
  fetchedAt: number;
  body: HistoryCatalogResponse;
}

/** The disk-cache surface the client uses (injectable for tests). */
export interface ReplayDiskCache {
  read(day: string): Promise<HistoryCatalogResponse | null>;
  write(day: string, body: HistoryCatalogResponse): Promise<void>;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'day' });
        store.createIndex('fetchedAt', 'fetchedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function readDay(day: string): Promise<HistoryCatalogResponse | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(day);
      req.onsuccess = () => {
        const rec = req.result as ReplayDayRecord | undefined;
        resolve(rec && rec.body && Array.isArray(rec.body.objects) ? rec.body : null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeDay(day: string, body: HistoryCatalogResponse): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const done = () => {
      db.close();
      resolve();
    };
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({ day, fetchedAt: Date.now(), body } satisfies ReplayDayRecord);
      // Evict the oldest-fetched days beyond the bound.
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - REPLAY_CACHE_MAX_DAYS;
        if (excess <= 0) return;
        const cur = store.index('fetchedAt').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || excess <= 0) return;
          c.delete();
          excess--;
          c.continue();
        };
      };
      tx.oncomplete = done;
      tx.onerror = done;
      tx.onabort = done;
    } catch {
      done();
    }
  });
}

/** The browser's IndexedDB-backed replay cache (no-op where IndexedDB is unavailable). */
export const idbReplayCache: ReplayDiskCache = { read: readDay, write: writeDay };
