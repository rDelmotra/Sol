import { bucketConfig, storageBackend } from '../config.js';
import { logger } from '../logger.js';
import { FileBlobStore } from './file-store.js';
import { createAwsS3Ops, S3BlobStore, type S3Ops } from './s3-store.js';
import type { BlobStore } from './types.js';

export { FileBlobStore } from './file-store.js';
export { S3BlobStore, createAwsS3Ops, isNotFound, type S3Config, type S3Ops } from './s3-store.js';
export { assertSafeKey, assertSafePrefix, type BlobInfo, type BlobStore } from './types.js';

export interface BlobStoreOptions {
  /** Directory the file backend writes into. */
  fileRoot: string;
  /** Key prefix inside the bucket for the s3 backend (for example 'history/raw'). */
  s3Prefix?: string;
  /** Test seam: replaces the real AWS-backed ops when the s3 backend is chosen. */
  s3Ops?: () => Promise<S3Ops>;
}

let warnedMisconfigured = false;

/**
 * Pick the backend from the environment, read on every call.
 *   STORAGE_BACKEND unset or 'file' -> files under `fileRoot` (the long-standing behaviour)
 *   STORAGE_BACKEND=s3, bucket vars complete -> the bucket
 *   STORAGE_BACKEND=s3, bucket vars missing  -> files, with one ERROR log: the data must
 *     never be dropped because a variable was mistyped.
 * Construction is cheap and does no network or SDK work.
 */
export function createBlobStore(opts: BlobStoreOptions): BlobStore {
  if (storageBackend() !== 's3') return new FileBlobStore(opts.fileRoot);

  const cfg = bucketConfig();
  if (!cfg && !opts.s3Ops) {
    if (!warnedMisconfigured) {
      warnedMisconfigured = true;
      logger.error(
        'STORAGE_BACKEND=s3 but BUCKET, ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY or REGION is missing — ' +
          'falling back to the attached volume so nothing is lost.',
      );
    }
    return new FileBlobStore(opts.fileRoot);
  }
  return new S3BlobStore(opts.s3Ops ?? (() => createAwsS3Ops(cfg!)), opts.s3Prefix ?? '');
}

/** Test helper: lets a test see the misconfiguration warning again. */
export function resetStorageWarningsForTests(): void {
  warnedMisconfigured = false;
}
