// ============================================================
// Blob storage port
//
// One small interface for "put these bytes under a key, get them back later", so the
// code that produces durable files (today the raw history archive) does not care
// whether they land on the attached volume or in an S3-compatible bucket.
//
// Keys are relative, forward-slash paths such as 'history/raw/2026-10-24.json.gz'.
// Both adapters validate them with assertSafeKey, so a bad key fails the same way
// everywhere and can never leave the store's root.
// ============================================================

export interface BlobInfo {
  /** Key relative to the store (no root, no prefix). */
  key: string;
  size: number;
}

export interface BlobStore {
  readonly kind: 'file' | 's3';
  /** Write (or replace) the object. The write is atomic: readers see the old or the new bytes, never a mix. */
  put(key: string, data: Buffer): Promise<void>;
  /** The bytes, or null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Every object whose key starts with `prefix` (default: all), sorted by key. */
  list(prefix?: string): Promise<BlobInfo[]>;
  /** Remove the object. Removing a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** Throws for keys that are empty, absolute, contain '..', '.', empty segments, backslashes or NUL. */
export function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new Error('storage key must be a non-empty string');
  if (key.includes('\0') || key.includes('\\')) throw new Error(`storage key has an illegal character: ${JSON.stringify(key)}`);
  if (key.startsWith('/')) throw new Error(`storage key must be relative: ${JSON.stringify(key)}`);
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`storage key has an illegal path segment: ${JSON.stringify(key)}`);
    }
  }
}

/** A list prefix is a key prefix: same rules, but it may be empty or end with '/'. */
export function assertSafePrefix(prefix: string): void {
  if (prefix === '') return;
  assertSafeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
}
