import type { EnrichedTLEObject } from './types';

// ============================================================
// Per-day historical catalog cache (IndexedDB)
//
// Stores each fetched /api/history/at?t=<day> snapshot on the user's disk, keyed
// by UTC day. Past days are immutable (forward-only history never rewrites them),
// so re-scrubbing to a visited day is instant — no re-download.
//
// Mirrors catalog-cache.ts (graceful degradation everywhere; defensive `omm`
// shape-guard) but lives in its OWN database so it never collides with the
// live-catalog cache's versioning. Every operation degrades to null / no-op on
// private mode, disabled storage, or quota errors.
// ============================================================

const DB_NAME = 'orbitwatch-history';
const DB_VERSION = 1;
const STORE = 'history-days';

export interface HistoryDayCacheRecord {
  /** UTC day 'YYYY-MM-DD' — also the IndexedDB key. */
  day: string;
  /** Backend snapshot version stamp (opaque to the client). */
  version: string;
  /** Client wall-clock ms when stored — the TTL key for "today". */
  fetchedAt: number;
  catalogData: EnrichedTLEObject[];
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
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Read a cached day snapshot, or null if absent/unavailable. */
export async function readHistoryDayCache(day: string): Promise<HistoryDayCacheRecord | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(day);
      req.onsuccess = () => {
        const record = (req.result as HistoryDayCacheRecord | undefined) ?? null;
        // Defensive: ignore a snapshot whose objects predate the OMM shape so we
        // never feed line1/line2-shaped data to json2satrec.
        if (record && record.catalogData[0] && !('omm' in record.catalogData[0])) {
          resolve(null);
          return;
        }
        resolve(record);
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

/** Write a day snapshot (overwrites). Never throws — best-effort. */
export async function writeHistoryDayCache(record: HistoryDayCacheRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, record.day);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
