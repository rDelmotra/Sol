import { assertSafeKey, assertSafePrefix, type BlobInfo, type BlobStat, type BlobStore, type PutOptions } from './types.js';

// ============================================================
// S3 adapter (Railway Buckets or any S3-compatible service)
//
// The adapter talks to a deliberately tiny `S3Ops` interface instead of the AWS SDK
// directly, for two reasons: the tests run against an in-memory fake with no network,
// and the SDK (a large package) is only imported when a bucket is actually in use
// (see createAwsS3Ops), so the default file backend loads nothing extra.
//
// An S3 PutObject is atomic by itself (readers never see half an object), so there is
// no tmp-and-rename step here. All keys are placed under `prefix` inside the bucket.
// ============================================================

/** Name of the object metadata entry that carries the original file's mtime (ms since epoch). */
export const MTIME_META_KEY = 'mtime-ms';

export interface S3Head {
  size: number;
  /** S3's own LastModified (the upload time), ms since epoch. */
  lastModifiedMs: number;
  /** The mtime-ms metadata, when the object was written with one. */
  mtimeMs?: number;
}

export interface S3Ops {
  /** `mtimeMs`, when given, is stored as object metadata (MTIME_META_KEY). */
  put(key: string, body: Buffer, mtimeMs?: number): Promise<void>;
  /** null when the object does not exist. */
  head(key: string): Promise<S3Head | null>;
  /** null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Every object under `prefix`, following pagination to the end. */
  list(prefix: string): Promise<BlobInfo[]>;
  /** Deleting a missing object is not an error (S3 semantics). */
  delete(key: string): Promise<void>;
}

export interface S3Config {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Some S3-compatible services need path-style URLs (bucket in the path, not the host). */
  pathStyle: boolean;
}

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly prefix: string;

  /** `getOps` is called on first use and memoised, so construction never touches the network or the SDK. */
  constructor(
    private readonly getOps: () => Promise<S3Ops>,
    prefix = '',
  ) {
    assertSafePrefix(prefix);
    this.prefix = prefix === '' || prefix.endsWith('/') ? prefix : prefix + '/';
  }

  private ops: Promise<S3Ops> | null = null;
  private loadOps(): Promise<S3Ops> {
    this.ops ??= this.getOps();
    return this.ops;
  }

  async put(key: string, data: Buffer, opts?: PutOptions): Promise<void> {
    assertSafeKey(key);
    await (await this.loadOps()).put(this.prefix + key, data, opts?.mtimeMs);
  }

  async stat(key: string): Promise<BlobStat | null> {
    assertSafeKey(key);
    const head = await (await this.loadOps()).head(this.prefix + key);
    return head ? { size: head.size, mtimeMs: head.mtimeMs ?? head.lastModifiedMs } : null;
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    return (await this.loadOps()).get(this.prefix + key);
  }

  async list(prefix = ''): Promise<BlobInfo[]> {
    assertSafePrefix(prefix);
    const found = await (await this.loadOps()).list(this.prefix + prefix);
    return found
      .filter((o) => o.key.startsWith(this.prefix))
      .map((o) => ({ key: o.key.slice(this.prefix.length), size: o.size }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await (await this.loadOps()).delete(this.prefix + key);
  }
}

/** True for the "object not found" errors the AWS SDK raises (NoSuchKey / HTTP 404). */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * The real S3Ops, backed by @aws-sdk/client-s3. The SDK is imported here, on first use,
 * so nothing loads it unless the s3 backend is selected.
 */
export async function createAwsS3Ops(cfg: S3Config): Promise<S3Ops> {
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.pathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;

  return {
    async put(key, body, mtimeMs) {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ...(mtimeMs !== undefined ? { Metadata: { [MTIME_META_KEY]: String(Math.round(mtimeMs)) } } : {}),
        }),
      );
    },
    async head(key) {
      try {
        const res = await client.send(new sdk.HeadObjectCommand({ Bucket, Key: key }));
        const meta = Number(res.Metadata?.[MTIME_META_KEY]);
        return {
          size: res.ContentLength ?? 0,
          lastModifiedMs: res.LastModified?.getTime() ?? 0,
          ...(Number.isFinite(meta) && meta > 0 ? { mtimeMs: meta } : {}),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async get(key) {
      try {
        const res = await client.send(new sdk.GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) return null;
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async list(prefix) {
      const out: BlobInfo[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new sdk.ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const obj of res.Contents ?? []) {
          if (obj.Key) out.push({ key: obj.Key, size: obj.Size ?? 0 });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async delete(key) {
      await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
